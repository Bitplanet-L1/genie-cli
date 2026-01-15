/**
 * Session API client for Genie CLI
 *
 * Handles WebSocket connection to Genie Relay Server
 * No E2E encryption - messages are sent in plaintext
 */

import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import { io, Socket } from 'socket.io-client'
import { AgentState, ClientToServerEvents, MessageContent, Metadata, ServerToClientEvents, Session, Update, UserMessage, UserMessageSchema, Usage } from './types'
import { backoff } from '@/utils/time'
import { configuration } from '@/configuration'
import { RawJSONLines } from '@/claude/types'
import { randomUUID } from 'node:crypto'
import { AsyncLock } from '@/utils/lock'
import { RpcHandlerManager } from './rpc/RpcHandlerManager'
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers'

/**
 * ACP (Agent Communication Protocol) message data types.
 * This is the unified format for all agent messages - CLI adapts each provider's format to ACP.
 */
export type ACPMessageData =
    // Core message types
    | { type: 'message'; message: string }
    | { type: 'reasoning'; message: string }
    | { type: 'thinking'; text: string }
    // Tool interactions
    | { type: 'tool-call'; callId: string; name: string; input: unknown; id: string }
    | { type: 'tool-result'; callId: string; output: unknown; id: string; isError?: boolean }
    // File operations
    | { type: 'file-edit'; description: string; filePath: string; diff?: string; oldContent?: string; newContent?: string; id: string }
    // Terminal/command output
    | { type: 'terminal-output'; data: string; callId: string }
    // Task lifecycle events
    | { type: 'task_started'; id: string }
    | { type: 'task_complete'; id: string }
    | { type: 'turn_aborted'; id: string }
    // Permissions
    | { type: 'permission-request'; permissionId: string; toolName: string; description: string; options?: unknown }
    // Usage/metrics
    | { type: 'token_count'; [key: string]: unknown }

export type ACPProvider = 'gemini' | 'codex' | 'claude' | 'opencode'

export class ApiSessionClient extends EventEmitter {
    private readonly token: string
    readonly sessionId: string
    private metadata: Metadata | null
    private metadataVersion: number
    private agentState: AgentState | null
    private agentStateVersion: number
    private socket: Socket<ServerToClientEvents, ClientToServerEvents>
    private pendingMessages: UserMessage[] = []
    private pendingMessageCallback: ((message: UserMessage) => void) | null = null
    readonly rpcHandlerManager: RpcHandlerManager
    private agentStateLock = new AsyncLock()
    private metadataLock = new AsyncLock()

    constructor(token: string, session: Session) {
        super()
        this.token = token
        this.sessionId = session.id
        this.metadata = session.metadata
        this.metadataVersion = session.metadataVersion
        this.agentState = session.agentState
        this.agentStateVersion = session.agentStateVersion

        // Initialize RPC handler manager (no encryption)
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.sessionId,
            logger: (msg, data) => logger.debug(msg, data)
        })
        registerCommonHandlers(this.rpcHandlerManager, this.metadata.path)

        //
        // Create socket - connect to Genie Relay Server
        //

        this.socket = io(configuration.relayServerUrl, {
            auth: {
                token: this.token,
                clientType: 'session-scoped' as const,
                sessionId: this.sessionId
            },
            path: '/v1/updates',
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            transports: ['websocket'],
            withCredentials: true,
            autoConnect: false
        })

        //
        // Handlers
        //

        this.socket.on('connect', () => {
            logger.debug('Socket connected successfully')
            this.rpcHandlerManager.onSocketConnect(this.socket)
        })

        // Set up global RPC request handler
        this.socket.on('rpc-request', async (data: { method: string; params: string }, callback: (response: string) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data))
        })

        this.socket.on('disconnect', (reason) => {
            logger.debug('[API] Socket disconnected:', reason)
            this.rpcHandlerManager.onSocketDisconnect()
        })

        this.socket.on('connect_error', (error) => {
            logger.debug('[API] Socket connection error:', error)
            this.rpcHandlerManager.onSocketDisconnect()
        })

        // Server events - handle updates (no decryption needed)
        this.socket.on('update', (data: Update) => {
            try {
                logger.debugLargeJson('[SOCKET] [UPDATE] Received update:', data)

                if (!data.body) {
                    logger.debug('[SOCKET] [UPDATE] [ERROR] No body in update!')
                    return
                }

                if (data.body.t === 'new-message') {
                    // For Genie, messages are not encrypted
                    const content = data.body.message.content
                    let body: unknown

                    if (content.t === 'encrypted') {
                        // GRS wraps messages in encrypted format schema, but content is plain JSON
                        // The 'c' field contains the JSON string of the actual message
                        try {
                            body = JSON.parse(content.c)
                            logger.debug('[SOCKET] [UPDATE] Parsed message from encrypted wrapper')
                        } catch {
                            logger.debug('[SOCKET] [UPDATE] Failed to parse encrypted message content - skipping')
                            return
                        }
                    } else {
                        body = content
                    }

                    logger.debugLargeJson('[SOCKET] [UPDATE] Received message:', body)

                    // Try to parse as user message first
                    const userResult = UserMessageSchema.safeParse(body)
                    if (userResult.success) {
                        if (this.pendingMessageCallback) {
                            this.pendingMessageCallback(userResult.data)
                        } else {
                            this.pendingMessages.push(userResult.data)
                        }
                    } else {
                        this.emit('message', body)
                    }
                } else if (data.body.t === 'update-session') {
                    if (data.body.metadata && data.body.metadata.version > this.metadataVersion) {
                        // Metadata is stored as plain JSON in Genie
                        try {
                            this.metadata = typeof data.body.metadata.value === 'string'
                                ? JSON.parse(data.body.metadata.value)
                                : data.body.metadata.value
                            this.metadataVersion = data.body.metadata.version
                        } catch {
                            logger.debug('[SOCKET] Failed to parse metadata')
                        }
                    }
                    if (data.body.agentState && data.body.agentState.version > this.agentStateVersion) {
                        try {
                            this.agentState = data.body.agentState.value
                                ? (typeof data.body.agentState.value === 'string'
                                    ? JSON.parse(data.body.agentState.value)
                                    : data.body.agentState.value)
                                : null
                            this.agentStateVersion = data.body.agentState.version
                        } catch {
                            logger.debug('[SOCKET] Failed to parse agentState')
                        }
                    }
                } else if (data.body.t === 'update-machine') {
                    logger.debug(`[SOCKET] WARNING: Session client received unexpected machine update - ignoring`)
                } else {
                    this.emit('message', data.body)
                }
            } catch (error) {
                logger.debug('[SOCKET] [UPDATE] [ERROR] Error handling update', { error })
            }
        })

        // DEATH
        this.socket.on('error', (error) => {
            logger.debug('[API] Socket error:', error)
        })

        //
        // Connect (after short delay to give a time to add handlers)
        //

        this.socket.connect()
    }

    onUserMessage(callback: (data: UserMessage) => void) {
        this.pendingMessageCallback = callback
        while (this.pendingMessages.length > 0) {
            callback(this.pendingMessages.shift()!)
        }
    }

    /**
     * Send message to session (no encryption)
     */
    sendClaudeSessionMessage(body: RawJSONLines) {
        let content: MessageContent

        if (body.type === 'user' && typeof body.message.content === 'string' && body.isSidechain !== true && body.isMeta !== true) {
            content = {
                role: 'user',
                content: {
                    type: 'text',
                    text: body.message.content
                },
                meta: {
                    sentFrom: 'cli'
                }
            }
        } else {
            content = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: body
                },
                meta: {
                    sentFrom: 'cli'
                }
            }
        }

        logger.debugLargeJson('[SOCKET] Sending message through socket:', content)

        if (!this.socket.connected) {
            logger.debug('[API] Socket not connected, cannot send Claude session message. Message will be lost:', { type: body.type })
            return
        }

        // Send message as plain JSON (no encryption)
        this.socket.emit('message', {
            sid: this.sessionId,
            message: JSON.stringify(content)
        })

        // Track usage from assistant messages
        if (body.type === 'assistant' && body.message?.usage) {
            try {
                this.sendUsageData(body.message.usage)
            } catch (error) {
                logger.debug('[SOCKET] Failed to send usage data:', error)
            }
        }

        // Update metadata with summary if this is a summary message
        if (body.type === 'summary' && 'summary' in body && 'leafUuid' in body) {
            this.updateMetadata((metadata) => ({
                ...metadata,
                summary: {
                    text: body.summary,
                    updatedAt: Date.now()
                }
            }))
        }
    }

    sendCodexMessage(body: unknown) {
        const content = {
            role: 'agent',
            content: {
                type: 'codex',
                data: body
            },
            meta: {
                sentFrom: 'cli'
            }
        }

        if (!this.socket.connected) {
            logger.debug('[API] Socket not connected, cannot send message.')
            return
        }

        this.socket.emit('message', {
            sid: this.sessionId,
            message: JSON.stringify(content)
        })
    }

    /**
     * Send a generic agent message to the session using ACP format.
     */
    sendAgentMessage(provider: ACPProvider, body: ACPMessageData) {
        const content = {
            role: 'agent',
            content: {
                type: 'acp',
                provider,
                data: body
            },
            meta: {
                sentFrom: 'cli'
            }
        }

        logger.debug(`[SOCKET] Sending ACP message from ${provider}:`, { type: body.type, hasMessage: 'message' in body })

        this.socket.emit('message', {
            sid: this.sessionId,
            message: JSON.stringify(content)
        })
    }

    sendSessionEvent(event: {
        type: 'switch'; mode: 'local' | 'remote'
    } | {
        type: 'message'; message: string
    } | {
        type: 'permission-mode-changed'; mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
    } | {
        type: 'ready'
    }, id?: string) {
        const content = {
            role: 'agent',
            content: {
                id: id ?? randomUUID(),
                type: 'event',
                data: event
            }
        }

        this.socket.emit('message', {
            sid: this.sessionId,
            message: JSON.stringify(content)
        })
    }

    /**
     * Send a ping message to keep the connection alive
     */
    keepAlive(thinking: boolean, mode: 'local' | 'remote') {
        if (process.env.DEBUG) {
            logger.debug(`[API] Sending keep alive message: ${thinking}`)
        }
        this.socket.volatile.emit('session-alive', {
            sid: this.sessionId,
            time: Date.now(),
            thinking,
            mode
        })
    }

    /**
     * Send session death message
     */
    sendSessionDeath() {
        this.socket.emit('session-end', { sid: this.sessionId, time: Date.now() })
    }

    /**
     * Send usage data to the server
     */
    sendUsageData(usage: Usage) {
        const totalTokens = usage.input_tokens + usage.output_tokens + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)

        const usageReport = {
            key: 'claude-session',
            sessionId: this.sessionId,
            tokens: {
                total: totalTokens,
                input: usage.input_tokens,
                output: usage.output_tokens,
                cache_creation: usage.cache_creation_input_tokens || 0,
                cache_read: usage.cache_read_input_tokens || 0
            },
            cost: {
                total: 0,
                input: 0,
                output: 0
            }
        }
        logger.debugLargeJson('[SOCKET] Sending usage data:', usageReport)
        this.socket.emit('usage-report', usageReport)
    }

    /**
     * Update session metadata (no encryption)
     */
    updateMetadata(handler: (metadata: Metadata) => Metadata) {
        this.metadataLock.inLock(async () => {
            await backoff(async () => {
                const updated = handler(this.metadata!)
                const answer = await this.socket.emitWithAck('update-metadata', {
                    sid: this.sessionId,
                    expectedVersion: this.metadataVersion,
                    metadata: JSON.stringify(updated)
                })
                if (answer.result === 'success') {
                    this.metadata = typeof answer.metadata === 'string' ? JSON.parse(answer.metadata) : answer.metadata
                    this.metadataVersion = answer.version
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.metadataVersion) {
                        this.metadataVersion = answer.version
                        this.metadata = typeof answer.metadata === 'string' ? JSON.parse(answer.metadata) : answer.metadata
                    }
                    throw new Error('Metadata version mismatch')
                }
            })
        })
    }

    /**
     * Update session agent state (no encryption)
     */
    updateAgentState(handler: (metadata: AgentState) => AgentState) {
        logger.debugLargeJson('Updating agent state', this.agentState)
        this.agentStateLock.inLock(async () => {
            await backoff(async () => {
                const updated = handler(this.agentState || {})
                const answer = await this.socket.emitWithAck('update-state', {
                    sid: this.sessionId,
                    expectedVersion: this.agentStateVersion,
                    agentState: updated ? JSON.stringify(updated) : null
                })
                if (answer.result === 'success') {
                    this.agentState = answer.agentState
                        ? (typeof answer.agentState === 'string' ? JSON.parse(answer.agentState) : answer.agentState)
                        : null
                    this.agentStateVersion = answer.version
                    logger.debug('Agent state updated', this.agentState)
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.agentStateVersion) {
                        this.agentStateVersion = answer.version
                        this.agentState = answer.agentState
                            ? (typeof answer.agentState === 'string' ? JSON.parse(answer.agentState) : answer.agentState)
                            : null
                    }
                    throw new Error('Agent state version mismatch')
                }
            })
        })
    }

    /**
     * Wait for socket buffer to flush
     */
    async flush(): Promise<void> {
        if (!this.socket.connected) {
            return
        }
        return new Promise((resolve) => {
            this.socket.emit('ping', () => {
                resolve()
            })
            setTimeout(() => {
                resolve()
            }, 10000)
        })
    }

    async close() {
        logger.debug('[API] socket.close() called')
        this.socket.close()
    }
}
