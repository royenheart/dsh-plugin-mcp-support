/**
 * Pure MCP-server config normalization and merge helpers.
 *
 * Deliberately free of cordis imports so these functions stay trivially
 * unit-testable. The schema mirrors the native `@deepseek-ai/dsh-mcp-client`
 * `Config` union so the settings layer accepts exactly what the native bridge
 * accepts — the wrapper itself never re-implements connection logic.
 */
import z from '@deepseek-ai/schemastery'

/** Valid native mcp-client `serverName`: `[A-Za-z0-9_-]{1,32}`. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Matches the native bridge's `@deepseek-ai/dsh-timeout` MAX_TIMER_DELAY_MS. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Default per-tool-call timeout used by the native bridge. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** Reconnect policy, defaults mirrored from the native bridge. */
export interface ReconnectConfig {
  enabled: boolean
  initialDelayMs: number
  maxDelayMs: number
  maxAttempts: number
}

/** Config for one MCP server reached over a spawned child process. */
export interface StdioServerConfig {
  transport: 'stdio'
  serverName: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  toolCallTimeoutMs: number
  failOnStartupError: boolean
  reconnect?: ReconnectConfig
}

/** Config for one MCP server reached over Streamable HTTP. */
export interface StreamableHttpServerConfig {
  transport: 'streamable-http'
  serverName: string
  url: string
  headers: Record<string, string>
  toolCallTimeoutMs: number
  failOnStartupError: boolean
  reconnect?: ReconnectConfig
}

/** One normalized MCP server config, discriminated on `transport`. */
export type McpServerConfig = StdioServerConfig | StreamableHttpServerConfig

/** Resolved shape of the persisted `mcp-support` settings namespace. */
export interface McpSupportSettings {
  servers: McpServerConfig[]
}

/** Composition-time plugin config: the optional initial server list. */
export interface McpSupportConfig {
  servers?: McpServerConfig[]
}

const Reconnect = z.object({
  enabled: z.boolean().default(true),
  initialDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(500),
  maxDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  maxAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(10),
})

/** Schemastery schema for one stdio or Streamable HTTP MCP server. */
export const ServerConfig = z.union([
  z.object({
    transport: z.const('stdio'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    command: z.string().required(),
    args: z.array(String).default([]),
    env: z.dict(String).default({}),
    cwd: z.string().default(''),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    failOnStartupError: z.boolean().default(false),
    reconnect: Reconnect,
  }),
  z.object({
    transport: z.const('streamable-http'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    url: z.string().required(),
    headers: z.dict(String).default({}),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    failOnStartupError: z.boolean().default(false),
    reconnect: Reconnect,
  }),
]) as unknown as z<McpServerConfig>

/** Schemastery schema for the persisted settings section. */
export const SettingsSchema = z.object({
  servers: z.array(ServerConfig).default([]),
})

/** Normalize a single raw server config through the schema. */
export function normalizeServerConfig(input: unknown): McpServerConfig {
  return ServerConfig(input as McpServerConfig) as McpServerConfig
}

/** Normalize a raw server list; `undefined`/`null` means empty. */
export function normalizeServerConfigs(input: unknown): McpServerConfig[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) {
    throw new Error('mcp-support: servers must be an array of MCP server configs')
  }
  return input.map((server, index) => {
    try {
      return normalizeServerConfig(server)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`mcp-support: servers[${index}] is invalid: ${message}`)
    }
  })
}

/** Throw a clear error when one source list repeats a serverName. */
export function validateUniqueServerNames(servers: McpServerConfig[]): void {
  const seen = new Set<string>()
  for (const server of servers) {
    if (seen.has(server.serverName)) {
      throw new Error(
        `mcp-support: duplicate serverName "${server.serverName}" — each MCP server must have a unique serverName`,
      )
    }
    seen.add(server.serverName)
  }
}

/**
 * Merge the composition-time server list with the persisted settings list.
 *
 * Composition servers come first; settings servers are appended in their own
 * order unless they override a composition entry with the same `serverName`.
 * Within each source, duplicate names are an error.
 */
export function mergeServers(composition: McpServerConfig[], settings: McpServerConfig[]): McpServerConfig[] {
  validateUniqueServerNames(composition)
  validateUniqueServerNames(settings)

  const byName = new Map<string, McpServerConfig>()
  const order: string[] = []
  for (const server of composition) {
    byName.set(server.serverName, server)
    order.push(server.serverName)
  }
  for (const server of settings) {
    if (!byName.has(server.serverName)) order.push(server.serverName)
    byName.set(server.serverName, server)
  }
  return order.map((name) => byName.get(name)!)
}

/** Test-friendly pure helper: normalize and merge both sources. */
export function servers(composition: unknown, settings: unknown): McpServerConfig[] {
  return mergeServers(normalizeServerConfigs(composition), normalizeServerConfigs(settings))
}

/** Cheap stable equality over normalized server configs. */
export function serverConfigsEqual(a: McpServerConfig, b: McpServerConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
