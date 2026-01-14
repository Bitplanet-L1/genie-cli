/**
 * API Client for Genie CLI
 *
 * Handles REST API communication with Genie Relay Server
 * No E2E encryption - data is sent as plain JSON
 */

import axios from 'axios'
import { logger } from '@/ui/logger'
import type { AgentState, CreateSessionResponse, Metadata, Session, Machine, MachineMetadata, DaemonState } from '@/api/types'
import { ApiSessionClient } from './apiSession'
import { ApiMachineClient } from './apiMachine'
import { PushNotificationClient } from './pushNotifications'
import { configuration } from '@/configuration'
import chalk from 'chalk'
import { Credentials } from '@/persistence'
import { connectionState, isNetworkError } from '@/utils/serverConnectionErrors'

/**
 * Vendor token structure for OAuth-based vendor authentication
 */
export interface VendorToken {
  oauth?: {
    access_token?: string
    refresh_token?: string
    id_token?: string
    expires_in?: number
    expires_at?: number
    token_type?: string
    scope?: string
  }
  [key: string]: unknown
}

export class ApiClient {

  static async create(credential: Credentials) {
    return new ApiClient(credential)
  }

  private readonly credential: Credentials
  private readonly pushClient: PushNotificationClient

  private constructor(credential: Credentials) {
    this.credential = credential
    this.pushClient = new PushNotificationClient(credential.access_token, configuration.relayServerUrl)
  }

  /**
   * Create a new session or load existing one with the given tag
   * No encryption - metadata and state are sent as plain JSON
   */
  async getOrCreateSession(opts: {
    tag: string
    metadata: Metadata
    state: AgentState | null
  }): Promise<Session | null> {

    try {
      const response = await axios.post<CreateSessionResponse>(
        `${configuration.relayServerUrl}/v1/sessions`,
        {
          tag: opts.tag,
          metadata: JSON.stringify(opts.metadata),
          agentState: opts.state ? JSON.stringify(opts.state) : null,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.access_token}`,
            'Content-Type': 'application/json'
          },
          timeout: 60000
        }
      )

      logger.debug(`Session created/loaded: ${response.data.session.id} (tag: ${opts.tag})`)
      const raw = response.data.session
      const session: Session = {
        id: raw.id,
        seq: raw.seq,
        metadata: typeof raw.metadata === 'string' ? JSON.parse(raw.metadata) : raw.metadata,
        metadataVersion: raw.metadataVersion,
        agentState: raw.agentState
          ? (typeof raw.agentState === 'string' ? JSON.parse(raw.agentState) : raw.agentState)
          : null,
        agentStateVersion: raw.agentStateVersion,
      }
      return session
    } catch (error) {
      logger.debug('[API] [ERROR] Failed to get or create session:', error)

      if (error && typeof error === 'object' && 'code' in error) {
        const errorCode = (error as { code: string }).code
        if (isNetworkError(errorCode)) {
          connectionState.fail({
            operation: 'Session creation',
            caller: 'api.getOrCreateSession',
            errorCode,
            url: `${configuration.relayServerUrl}/v1/sessions`
          })
          return null
        }
      }

      const is404Error = (
        (axios.isAxiosError(error) && error.response?.status === 404) ||
        (error && typeof error === 'object' && 'response' in error && (error as { response?: { status?: number } }).response?.status === 404)
      )
      if (is404Error) {
        connectionState.fail({
          operation: 'Session creation',
          errorCode: '404',
          url: `${configuration.relayServerUrl}/v1/sessions`
        })
        return null
      }

      if (axios.isAxiosError(error) && error.response?.status) {
        const status = error.response.status
        if (status >= 500) {
          connectionState.fail({
            operation: 'Session creation',
            errorCode: String(status),
            url: `${configuration.relayServerUrl}/v1/sessions`,
            details: ['Server encountered an error, will retry automatically']
          })
          return null
        }
      }

      throw new Error(`Failed to get or create session: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Register or update machine with the server
   * No encryption - metadata and state are sent as plain JSON
   */
  async getOrCreateMachine(opts: {
    machineId: string
    metadata: MachineMetadata
    daemonState?: DaemonState
  }): Promise<Machine> {

    const createMinimalMachine = (): Machine => ({
      id: opts.machineId,
      metadata: opts.metadata,
      metadataVersion: 0,
      daemonState: opts.daemonState || null,
      daemonStateVersion: 0,
    })

    try {
      const response = await axios.post(
        `${configuration.relayServerUrl}/v1/machines`,
        {
          id: opts.machineId,
          metadata: JSON.stringify(opts.metadata),
          daemonState: opts.daemonState ? JSON.stringify(opts.daemonState) : undefined,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.access_token}`,
            'Content-Type': 'application/json'
          },
          timeout: 60000
        }
      )

      const raw = response.data.machine
      logger.debug(`[API] Machine ${opts.machineId} registered/updated with server`)

      const machine: Machine = {
        id: raw.id,
        metadata: raw.metadata
          ? (typeof raw.metadata === 'string' ? JSON.parse(raw.metadata) : raw.metadata)
          : opts.metadata,
        metadataVersion: raw.metadataVersion || 0,
        daemonState: raw.daemonState
          ? (typeof raw.daemonState === 'string' ? JSON.parse(raw.daemonState) : raw.daemonState)
          : null,
        daemonStateVersion: raw.daemonStateVersion || 0,
      }
      return machine
    } catch (error) {
      if (axios.isAxiosError(error) && error.code && isNetworkError(error.code)) {
        connectionState.fail({
          operation: 'Machine registration',
          caller: 'api.getOrCreateMachine',
          errorCode: error.code,
          url: `${configuration.relayServerUrl}/v1/machines`
        })
        return createMinimalMachine()
      }

      if (axios.isAxiosError(error) && error.response?.status) {
        const status = error.response.status

        if (status === 403 || status === 409) {
          console.log(chalk.yellow(
            `Warning: Machine registration rejected by the server with status ${status}`
          ))
          console.log(chalk.yellow(
            `   This machine ID is already registered to another account on the server`
          ))
          console.log(chalk.yellow(
            `   Run 'genie doctor clean' to reset local state and generate a new machine ID`
          ))
          return createMinimalMachine()
        }

        if (status >= 500) {
          connectionState.fail({
            operation: 'Machine registration',
            errorCode: String(status),
            url: `${configuration.relayServerUrl}/v1/machines`,
            details: ['Server encountered an error, will retry automatically']
          })
          return createMinimalMachine()
        }

        if (status === 404) {
          connectionState.fail({
            operation: 'Machine registration',
            errorCode: '404',
            url: `${configuration.relayServerUrl}/v1/machines`
          })
          return createMinimalMachine()
        }
      }

      throw error
    }
  }

  sessionSyncClient(session: Session): ApiSessionClient {
    return new ApiSessionClient(this.credential.access_token, session)
  }

  machineSyncClient(machine: Machine): ApiMachineClient {
    return new ApiMachineClient(this.credential.access_token, machine)
  }

  push(): PushNotificationClient {
    return this.pushClient
  }

  /**
   * Register a vendor API token with the server
   */
  async registerVendorToken(vendor: 'openai' | 'anthropic' | 'gemini', apiKey: unknown): Promise<void> {
    try {
      const response = await axios.post(
        `${configuration.relayServerUrl}/v1/connect/${vendor}/register`,
        {
          token: JSON.stringify(apiKey)
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.access_token}`,
            'Content-Type': 'application/json'
          },
          timeout: 5000
        }
      )

      if (response.status !== 200 && response.status !== 201) {
        throw new Error(`Server returned status ${response.status}`)
      }

      logger.debug(`[API] Vendor token for ${vendor} registered successfully`)
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to register vendor token:`, error)
      throw new Error(`Failed to register vendor token: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Get vendor API token from the server
   */
  async getVendorToken(vendor: 'openai' | 'anthropic' | 'gemini'): Promise<VendorToken | null> {
    try {
      const response = await axios.get(
        `${configuration.relayServerUrl}/v1/connect/${vendor}/token`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.access_token}`,
            'Content-Type': 'application/json'
          },
          timeout: 5000
        }
      )

      if (response.status === 404) {
        logger.debug(`[API] No vendor token found for ${vendor}`)
        return null
      }

      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`)
      }

      logger.debug(`[API] Raw vendor token response:`, {
        status: response.status,
        dataKeys: Object.keys(response.data || {}),
        hasToken: 'token' in (response.data || {}),
        tokenType: typeof response.data?.token,
      })

      let tokenData: unknown = null
      if (response.data?.token) {
        if (typeof response.data.token === 'string') {
          try {
            tokenData = JSON.parse(response.data.token)
          } catch {
            tokenData = response.data.token
          }
        } else if (response.data.token !== null) {
          tokenData = response.data.token
        } else {
          logger.debug(`[API] Token is null for ${vendor}, treating as not found`)
          return null
        }
      } else if (response.data && typeof response.data === 'object') {
        if (response.data.token === null && Object.keys(response.data).length === 1) {
          logger.debug(`[API] Response contains only null token for ${vendor}, treating as not found`)
          return null
        }
        tokenData = response.data
      }

      if (tokenData === null) {
        logger.debug(`[API] Token data is null for ${vendor}`)
        return null
      }

      logger.debug(`[API] Vendor token for ${vendor} retrieved successfully`)
      return tokenData as VendorToken
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        logger.debug(`[API] No vendor token found for ${vendor}`)
        return null
      }
      logger.debug(`[API] [ERROR] Failed to get vendor token:`, error)
      return null
    }
  }
}
