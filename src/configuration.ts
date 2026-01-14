/**
 * Global configuration for Genie CLI
 *
 * Centralizes all configuration including environment variables and paths
 * Environment files should be loaded using Node's --env-file flag
 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json'

class Configuration {
  // Genie Relay Server (WebSocket)
  public readonly relayServerUrl: string
  // Content Server (OIDC auth)
  public readonly contentServerUrl: string
  // Web URL (for SSO authorization)
  public readonly webUrl: string
  // OIDC configuration
  public readonly oidcClientId: string
  public readonly oidcScopes: string

  public readonly isDaemonProcess: boolean

  // Directories and paths
  public readonly genieHomeDir: string
  public readonly logsDir: string
  public readonly settingsFile: string
  public readonly credentialsFile: string
  public readonly daemonStateFile: string
  public readonly daemonLockFile: string
  public readonly currentCliVersion: string

  public readonly isExperimentalEnabled: boolean
  public readonly disableCaffeinate: boolean

  // Legacy aliases for backward compatibility during migration
  public readonly serverUrl: string
  public readonly happyHomeDir: string
  public readonly privateKeyFile: string

  constructor() {
    // Genie server configuration
    this.relayServerUrl = process.env.GENIE_RELAY_SERVER_URL || 'https://grs.deva.me'
    this.contentServerUrl = process.env.GENIE_CONTENT_SERVER_URL || 'https://api.deva.me'
    this.webUrl = process.env.GENIE_WEB_URL || 'https://deva.me'

    // OIDC configuration
    this.oidcClientId = process.env.GENIE_OIDC_CLIENT_ID || 'a1b73d25-c892-401c-82bf-ce9614377ebb'
    this.oidcScopes = process.env.GENIE_OIDC_SCOPES || 'OPENID USER:READ PERSONA:READ PERSONA:PUBLIC_READ'

    // Check if we're running as daemon based on process args
    const args = process.argv.slice(2)
    this.isDaemonProcess = args.length >= 2 && args[0] === 'daemon' && (args[1] === 'start-sync')

    // Directory configuration - Priority: GENIE_HOME_DIR env > default home dir
    if (process.env.GENIE_HOME_DIR) {
      const expandedPath = process.env.GENIE_HOME_DIR.replace(/^~/, homedir())
      this.genieHomeDir = expandedPath
    } else {
      this.genieHomeDir = join(homedir(), '.genie')
    }

    this.logsDir = join(this.genieHomeDir, 'logs')
    this.settingsFile = join(this.genieHomeDir, 'settings.json')
    this.credentialsFile = join(this.genieHomeDir, 'deva_credentials.json')
    this.daemonStateFile = join(this.genieHomeDir, 'daemon.state.json')
    this.daemonLockFile = join(this.genieHomeDir, 'daemon.state.json.lock')

    this.isExperimentalEnabled = ['true', '1', 'yes'].includes(process.env.GENIE_EXPERIMENTAL?.toLowerCase() || '');
    this.disableCaffeinate = ['true', '1', 'yes'].includes(process.env.GENIE_DISABLE_CAFFEINATE?.toLowerCase() || '');

    this.currentCliVersion = packageJson.version

    // Legacy aliases for backward compatibility
    this.serverUrl = this.relayServerUrl
    this.happyHomeDir = this.genieHomeDir
    this.privateKeyFile = this.credentialsFile

    // Validate variant configuration
    const variant = process.env.GENIE_VARIANT || 'stable'
    if (variant === 'dev' && !this.genieHomeDir.includes('dev')) {
      console.warn('⚠️  WARNING: GENIE_VARIANT=dev but GENIE_HOME_DIR does not contain "dev"')
      console.warn(`   Current: ${this.genieHomeDir}`)
      console.warn(`   Expected: Should contain "dev" (e.g., ~/.genie-dev)`)
    }

    // Visual indicator on CLI startup (only if not daemon process to avoid log clutter)
    if (!this.isDaemonProcess) {
      if (variant === 'dev') {
        console.log('\x1b[33m🔧 DEV MODE\x1b[0m - Data: ' + this.genieHomeDir)
      } else {
        console.log('\x1b[32m✅ STABLE MODE\x1b[0m - Data: ' + this.genieHomeDir)
      }
    }

    if (!existsSync(this.genieHomeDir)) {
      mkdirSync(this.genieHomeDir, { recursive: true })
    }
    // Ensure directories exist
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true })
    }
  }
}

export const configuration: Configuration = new Configuration()
