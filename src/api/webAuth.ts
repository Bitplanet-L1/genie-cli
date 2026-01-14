import { configuration } from '@/configuration';

/**
 * Generate a URL for web authentication
 * Note: This function is likely not needed for Genie CLI's OIDC flow,
 * but kept for backward compatibility
 * @returns The web authentication URL
 */
export function generateWebAuthUrl(): string {
    return `${configuration.webUrl}/terminal/connect`;
}
