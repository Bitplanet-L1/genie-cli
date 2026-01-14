/**
 * Common RPC types and interfaces for both session and machine clients
 * No encryption - messages are sent in plaintext for Genie CLI
 */

/**
 * Generic RPC handler function type
 * @template TRequest - The request data type
 * @template TResponse - The response data type
 */
export type RpcHandler<TRequest = unknown, TResponse = unknown> = (
    data: TRequest
) => TResponse | Promise<TResponse>

/**
 * Map of method names to their handlers
 */
export type RpcHandlerMap = Map<string, RpcHandler>

/**
 * RPC request data from server
 */
export interface RpcRequest {
    method: string
    params: string // JSON string (no encryption)
}

/**
 * RPC response callback
 */
export type RpcResponseCallback = (response: string) => void

/**
 * Configuration for RPC handler manager
 */
export interface RpcHandlerConfig {
    scopePrefix: string
    logger?: (message: string, data?: unknown) => void
}

/**
 * Result of RPC handler execution
 */
export type RpcHandlerResult<T = unknown> =
    | { success: true; data: T }
    | { success: false; error: string }
