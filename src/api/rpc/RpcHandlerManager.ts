/**
 * Generic RPC handler manager for session and machine clients
 * Manages RPC method registration and handler execution
 * No encryption - messages are sent in plaintext for Genie CLI
 */

import { logger as defaultLogger } from '@/ui/logger'
import {
    RpcHandler,
    RpcHandlerMap,
    RpcRequest,
    RpcHandlerConfig,
} from './types'
import { Socket } from 'socket.io-client'

export class RpcHandlerManager {
    private handlers: RpcHandlerMap = new Map()
    private readonly scopePrefix: string
    private readonly logger: (message: string, data?: unknown) => void
    private socket: Socket | null = null

    constructor(config: RpcHandlerConfig) {
        this.scopePrefix = config.scopePrefix
        this.logger = config.logger || ((msg, data) => defaultLogger.debug(msg, data))
    }

    /**
     * Register an RPC handler for a specific method
     * @param method - The method name (without prefix)
     * @param handler - The handler function
     */
    registerHandler<TRequest = unknown, TResponse = unknown>(
        method: string,
        handler: RpcHandler<TRequest, TResponse>
    ): void {
        const prefixedMethod = this.getPrefixedMethod(method)

        // Store the handler
        this.handlers.set(prefixedMethod, handler as RpcHandler)

        if (this.socket) {
            this.socket.emit('rpc-register', { method: prefixedMethod })
        }
    }

    /**
     * Handle an incoming RPC request (no encryption)
     * @param request - The RPC request data
     */
    async handleRequest(request: RpcRequest): Promise<string> {
        try {
            const handler = this.handlers.get(request.method)

            if (!handler) {
                this.logger('[RPC] [ERROR] Method not found', { method: request.method })
                return JSON.stringify({ error: 'Method not found' })
            }

            // Parse the JSON params (no decryption needed)
            let params: unknown
            try {
                params = JSON.parse(request.params)
            } catch {
                params = request.params
            }

            // Call the handler
            this.logger('[RPC] Calling handler', { method: request.method })
            const result = await handler(params)
            this.logger('[RPC] Handler returned', { method: request.method, hasResult: result !== undefined })

            // Return the response as JSON
            const response = JSON.stringify(result)
            this.logger('[RPC] Sending response', { method: request.method, responseLength: response.length })
            return response
        } catch (error) {
            this.logger('[RPC] [ERROR] Error handling request', { error })
            return JSON.stringify({
                error: error instanceof Error ? error.message : 'Unknown error'
            })
        }
    }

    onSocketConnect(socket: Socket): void {
        this.socket = socket
        for (const [prefixedMethod] of this.handlers) {
            socket.emit('rpc-register', { method: prefixedMethod })
        }
    }

    onSocketDisconnect(): void {
        this.socket = null
    }

    /**
     * Get the number of registered handlers
     */
    getHandlerCount(): number {
        return this.handlers.size
    }

    /**
     * Check if a handler is registered
     * @param method - The method name (without prefix)
     */
    hasHandler(method: string): boolean {
        const prefixedMethod = this.getPrefixedMethod(method)
        return this.handlers.has(prefixedMethod)
    }

    /**
     * Clear all handlers
     */
    clearHandlers(): void {
        this.handlers.clear()
        this.logger('Cleared all RPC handlers')
    }

    /**
     * Get the prefixed method name
     * @param method - The method name
     */
    private getPrefixedMethod(method: string): string {
        return `${this.scopePrefix}:${method}`
    }
}

/**
 * Factory function to create an RPC handler manager
 */
export function createRpcHandlerManager(config: RpcHandlerConfig): RpcHandlerManager {
    return new RpcHandlerManager(config)
}
