/**
 * OIDC Authentication module for Genie CLI
 *
 * Implements Deva SSO authentication using PKCE (Proof Key for Code Exchange)
 */

import crypto from 'node:crypto'
import axios, { AxiosError } from 'axios'
import { configuration } from '@/configuration'
import { logger } from '@/ui/logger'

/**
 * Token response from OIDC token endpoint
 */
export interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
}

/**
 * Generate PKCE code_verifier (32 random bytes, base64url encoded)
 */
export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url')
}

/**
 * Generate PKCE code_challenge from verifier (SHA-256 hash, base64url encoded)
 */
export function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

/**
 * Build the authorization URL for Deva SSO
 */
export function buildAuthorizationUrl(codeChallenge: string): string {
  const params = new URLSearchParams({
    client_id: configuration.oidcClientId,
    response_type: 'code',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    scope: configuration.oidcScopes,
  })
  return `${configuration.webUrl}/sso/authorize?${params.toString()}`
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(
  authCode: string,
  codeVerifier: string
): Promise<TokenResponse> {
  const tokenEndpoint = `${configuration.contentServerUrl}/oidc/token`

  const payload = {
    client_id: configuration.oidcClientId,
    authorization_code: authCode,
    code_verifier: codeVerifier,
    expires_in: 3600,
  }

  logger.debug(`[AUTH] Exchanging code at: ${tokenEndpoint}`)

  try {
    const response = await axios.post<TokenResponse>(tokenEndpoint, payload)
    return response.data
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<{ message?: string; error?: string }>
      const errorMessage =
        axiosError.response?.data?.message ||
        axiosError.response?.data?.error ||
        axiosError.message
      throw new Error(`Failed to exchange code: ${errorMessage}`)
    }
    throw error
  }
}

/**
 * Refresh the access token using refresh token
 */
export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const tokenEndpoint = `${configuration.contentServerUrl}/oidc/token/refresh`

  const payload = {
    client_id: configuration.oidcClientId,
    refresh_token: refreshToken,
  }

  logger.debug(`[AUTH] Refreshing token at: ${tokenEndpoint}`)

  try {
    const response = await axios.post<TokenResponse>(tokenEndpoint, payload)
    return response.data
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<{ message?: string; error?: string }>
      const errorMessage =
        axiosError.response?.data?.message ||
        axiosError.response?.data?.error ||
        axiosError.message
      throw new Error(`Failed to refresh token: ${errorMessage}`)
    }
    throw error
  }
}
