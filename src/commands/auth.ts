/**
 * Authentication CLI commands for Genie CLI
 *
 * Handles login, logout, and status commands
 */

import chalk from 'chalk'
import { createInterface } from 'node:readline'
import { existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import { readCredentials, clearCredentials, clearMachineId, readSettings, isTokenExpired } from '@/persistence'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { configuration } from '@/configuration'
import { stopDaemon, checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient'
import { logger } from '@/ui/logger'

export async function handleAuthCommand(args: string[]): Promise<void> {
  const subcommand = args[0]

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showAuthHelp()
    return
  }

  switch (subcommand) {
    case 'login':
      await handleAuthLogin(args.slice(1))
      break
    case 'logout':
      await handleAuthLogout()
      break
    case 'status':
      await handleAuthStatus()
      break
    default:
      console.error(chalk.red(`Unknown auth subcommand: ${subcommand}`))
      showAuthHelp()
      process.exit(1)
  }
}

function showAuthHelp(): void {
  console.log(`
${chalk.bold('genie auth')} - Authentication management

${chalk.bold('Usage:')}
  genie auth login [--force]    Authenticate with Deva SSO
  genie auth logout             Remove authentication and machine data
  genie auth status             Show authentication status
  genie auth help               Show this help message

${chalk.bold('Options:')}
  --force    Clear credentials, machine ID, and stop daemon before re-auth

${chalk.gray('Authentication uses Deva SSO (OIDC with PKCE). A browser will open for')}
${chalk.gray('authorization, and you will need to paste the authorization code.')}
`)
}

async function handleAuthLogin(args: string[]): Promise<void> {
  const forceAuth = args.includes('--force') || args.includes('-f')

  if (forceAuth) {
    console.log(chalk.yellow('Force authentication requested.'))
    console.log(chalk.gray('This will:'))
    console.log(chalk.gray('  - Clear existing credentials'))
    console.log(chalk.gray('  - Clear machine ID'))
    console.log(chalk.gray('  - Stop daemon if running'))
    console.log(chalk.gray('  - Re-authenticate\n'))

    // Stop daemon if running
    try {
      logger.debug('Stopping daemon for force auth...')
      await stopDaemon()
      console.log(chalk.gray('Stopped daemon'))
    } catch (error) {
      logger.debug('Daemon was not running or failed to stop:', error)
    }

    // Clear credentials
    await clearCredentials()
    console.log(chalk.gray('Cleared credentials'))

    // Clear machine ID
    await clearMachineId()
    console.log(chalk.gray('Cleared machine ID'))

    console.log('')
  }

  // Check if already authenticated (if not forcing)
  if (!forceAuth) {
    const existingCreds = await readCredentials()
    const settings = await readSettings()

    if (existingCreds && settings?.machineId) {
      const expired = isTokenExpired(existingCreds)
      if (!expired) {
        console.log(chalk.green('Already authenticated'))
        console.log(chalk.gray(`  Machine ID: ${settings.machineId}`))
        console.log(chalk.gray(`  Host: ${os.hostname()}`))
        console.log(chalk.gray(`  Use 'genie auth login --force' to re-authenticate`))
        return
      } else {
        console.log(chalk.yellow('Token expired, will attempt refresh during setup...'))
      }
    } else if (existingCreds && !settings?.machineId) {
      console.log(chalk.yellow('Credentials exist but machine ID is missing'))
      console.log(chalk.gray('  Fixing by setting up machine...\n'))
    }
  }

  // Perform authentication and machine setup
  try {
    const result = await authAndSetupMachineIfNeeded()
    console.log(chalk.green('\nAuthentication successful'))
    console.log(chalk.gray(`  Machine ID: ${result.machineId}`))
  } catch (error) {
    console.error(chalk.red('Authentication failed:'), error instanceof Error ? error.message : 'Unknown error')
    process.exit(1)
  }
}

async function handleAuthLogout(): Promise<void> {
  const genieDir = configuration.genieHomeDir

  // Check if authenticated
  const credentials = await readCredentials()
  if (!credentials) {
    console.log(chalk.yellow('Not currently authenticated'))
    return
  }

  console.log(chalk.blue('This will log you out of Genie'))
  console.log(chalk.yellow('You will need to re-authenticate to use Genie again'))

  // Ask for confirmation
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const answer = await new Promise<string>((resolve) => {
    rl.question(chalk.yellow('Are you sure you want to log out? (y/N): '), resolve)
  })

  rl.close()

  if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
    try {
      // Stop daemon if running
      try {
        await stopDaemon()
        console.log(chalk.gray('Stopped daemon'))
      } catch {
        // Ignore if daemon not running
      }

      // Remove entire genie directory
      if (existsSync(genieDir)) {
        rmSync(genieDir, { recursive: true, force: true })
      }

      console.log(chalk.green('Successfully logged out'))
      console.log(chalk.gray('  Run "genie auth login" to authenticate again'))
    } catch (error) {
      throw new Error(`Failed to logout: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  } else {
    console.log(chalk.blue('Logout cancelled'))
  }
}

async function handleAuthStatus(): Promise<void> {
  const credentials = await readCredentials()
  const settings = await readSettings()

  console.log(chalk.bold('\nAuthentication Status\n'))

  if (!credentials) {
    console.log(chalk.red('Not authenticated'))
    console.log(chalk.gray('  Run "genie auth login" to authenticate'))
    return
  }

  // Check token status
  const expired = isTokenExpired(credentials)
  if (expired) {
    console.log(chalk.yellow('Authenticated (token expired)'))
    console.log(chalk.gray('  Token will be refreshed on next use'))
  } else {
    console.log(chalk.green('Authenticated'))
  }

  // Token preview (first few chars for security)
  const tokenPreview = credentials.access_token.substring(0, 30) + '...'
  console.log(chalk.gray(`  Token: ${tokenPreview}`))

  // Expiration info
  if (credentials.expires_at) {
    const expiresAt = new Date(credentials.expires_at)
    console.log(chalk.gray(`  Expires: ${expiresAt.toISOString()}`))
  } else {
    console.log(chalk.gray('  Expires: No expiration set'))
  }

  // Machine status
  if (settings?.machineId) {
    console.log(chalk.green('Machine registered'))
    console.log(chalk.gray(`  Machine ID: ${settings.machineId}`))
    console.log(chalk.gray(`  Host: ${os.hostname()}`))
  } else {
    console.log(chalk.yellow('Machine not registered'))
    console.log(chalk.gray('  Run "genie auth login --force" to fix this'))
  }

  // Data location
  console.log(chalk.gray(`\n  Data directory: ${configuration.genieHomeDir}`))

  // Daemon status
  try {
    const running = await checkIfDaemonRunningAndCleanupStaleState()
    if (running) {
      console.log(chalk.green('Daemon running'))
    } else {
      console.log(chalk.gray('Daemon not running'))
    }
  } catch {
    console.log(chalk.gray('Daemon not running'))
  }
}
