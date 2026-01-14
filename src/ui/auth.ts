/**
 * Authentication UI for Genie CLI
 *
 * Implements browser-based Deva SSO authentication flow
 */

import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import chalk from 'chalk'
import open from 'open'
import {
  generateCodeVerifier,
  generateCodeChallenge,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
} from '@/api/auth'
import {
  writeCredentials,
  readCredentials,
  updateSettings,
  GenieCredentials,
  isTokenExpired,
} from '@/persistence'
import { logger } from './logger'

/**
 * Run the Deva SSO authentication flow
 * Opens browser for authorization and prompts user to paste the code
 */
export async function doAuth(): Promise<GenieCredentials | null> {
  console.clear()
  console.log(chalk.cyan('\n' + '='.repeat(60)))
  console.log(chalk.cyan.bold('  Genie CLI Authentication'))
  console.log(chalk.cyan('='.repeat(60) + '\n'))

  // Step 1: Generate PKCE pair
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  logger.debug('[AUTH] Generated PKCE code_verifier and code_challenge')
  console.log(chalk.gray('Generated PKCE challenge'))

  // Step 2: Build and open authorization URL
  const authUrl = buildAuthorizationUrl(codeChallenge)
  console.log(chalk.yellow('\nOpening browser for authentication...'))

  try {
    await open(authUrl)
    console.log(chalk.green('Browser opened successfully\n'))
  } catch {
    console.log(chalk.yellow('Could not open browser automatically.\n'))
  }

  console.log(chalk.gray('If the browser did not open, please copy and paste this URL:'))
  console.log(chalk.cyan(authUrl))
  console.log('')

  // Step 3: Wait for authorization code with retry loop
  const credentials = await waitForAuthCodeAndExchange(codeVerifier, 15)

  if (!credentials) {
    console.log(chalk.red('\nAuthentication failed or timed out.'))
    return null
  }

  // Step 4: Save credentials
  await writeCredentials(credentials)

  console.log(chalk.green('\n' + '='.repeat(60)))
  console.log(chalk.green.bold('  Authentication successful!'))
  console.log(chalk.green('='.repeat(60) + '\n'))

  return credentials
}

/**
 * Prompt user for input
 */
function getUserInput(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

/**
 * Wait for authorization code with timeout and retry on error
 */
async function waitForAuthCodeAndExchange(
  codeVerifier: string,
  timeoutMinutes: number = 15
): Promise<GenieCredentials | null> {
  const timeoutMs = timeoutMinutes * 60 * 1000
  const startTime = Date.now()

  console.log(chalk.cyan('After authorizing, copy and paste the authorization code here.'))
  console.log(chalk.gray(`(Timeout: ${timeoutMinutes} minutes)\n`))

  while (Date.now() - startTime < timeoutMs) {
    try {
      const authCode = await getUserInput(chalk.yellow('Authorization Code: '))
      if (!authCode) {
        console.log(chalk.yellow('Code cannot be empty. Please try again.\n'))
        continue
      }

      console.log(chalk.gray('\nExchanging authorization code for access token...'))

      try {
        const tokens = await exchangeCodeForTokens(authCode, codeVerifier)
        return {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: Date.now() + tokens.expires_in * 1000,
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        console.log(chalk.red(`\nFailed to exchange code: ${errorMessage}`))

        const remainingMinutes = Math.floor((timeoutMs - (Date.now() - startTime)) / 60000)
        if (remainingMinutes > 0) {
          console.log(chalk.yellow('\nInvalid or expired authorization code.'))
          console.log(chalk.gray(`Time remaining: ${remainingMinutes} minutes`))
          console.log(chalk.gray('Please try again with a valid authorization code.\n'))
        } else {
          console.log(chalk.red('\nTimeout: Unable to obtain valid authorization code.'))
          return null
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('SIGINT')) {
        console.log(chalk.red('\n\nCancelled by user.'))
        process.exit(0)
      }
      throw error
    }
  }

  return null
}

/**
 * Ensure authentication and machine setup
 * Returns credentials and machine ID, handling token refresh if needed
 */
export async function authAndSetupMachineIfNeeded(): Promise<{
  credentials: GenieCredentials
  machineId: string
}> {
  logger.debug('[AUTH] Starting auth and machine setup...')

  // Step 1: Handle authentication
  let credentials = await readCredentials()
  let newAuth = false

  if (!credentials) {
    logger.debug('[AUTH] No credentials found, starting authentication flow...')
    const authResult = await doAuth()
    if (!authResult) {
      throw new Error('Authentication failed or was cancelled')
    }
    credentials = authResult
    newAuth = true
  } else if (isTokenExpired(credentials)) {
    // Try to refresh the token
    logger.debug('[AUTH] Token expired, attempting refresh...')
    try {
      const tokens = await refreshAccessToken(credentials.refresh_token)
      credentials = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + tokens.expires_in * 1000,
      }
      await writeCredentials(credentials)
      logger.debug('[AUTH] Token refreshed successfully')
    } catch (error) {
      logger.debug('[AUTH] Token refresh failed, starting new authentication flow...')
      const authResult = await doAuth()
      if (!authResult) {
        throw new Error('Authentication failed or was cancelled')
      }
      credentials = authResult
      newAuth = true
    }
  } else {
    logger.debug('[AUTH] Using existing valid credentials')
  }

  // Step 2: Ensure machine ID exists
  const settings = await updateSettings(async (s) => {
    if (newAuth || !s.machineId) {
      return {
        ...s,
        machineId: randomUUID(),
      }
    }
    return s
  })

  logger.debug(`[AUTH] Machine ID: ${settings.machineId}`)

  return { credentials, machineId: settings.machineId! }
}
