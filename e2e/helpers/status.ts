/**
 * Typed reads of the plugin's browser-facing status endpoint.
 *
 * The endpoint is the host half's user-visible projection: one row per
 * effective server with its transport, mounted state, and last mount error.
 * Specs read it through {@link settledStatus} so a boot that is still mounting
 * children can never be sampled mid-flight.
 */
import { STATUS_PATH, type WebProfile } from './dsh.ts'
import { pollStable } from './poll.ts'

/** Wire shape of one status row. */
export interface McpServerStatus {
  serverName: string
  transport: 'stdio' | 'streamable-http'
  mounted: boolean
  error?: string
}

/** One parsed status response. */
export interface StatusRead {
  httpStatus: number
  ok: boolean
  servers: McpServerStatus[]
  error?: string
  /** Raw parsed JSON body (or undefined when the body was not JSON). */
  body: unknown
}

/**
 * Fetch and parse the status route once.
 * @param web - running web profile handle.
 * @param init - optional fetch init (method, headers).
 * @returns the parsed response.
 */
export async function readStatus(web: WebProfile, init?: RequestInit): Promise<StatusRead> {
  const response = await web.request(STATUS_PATH, init)
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text) as unknown
  } catch {
    body = undefined
  }
  const record = (body ?? {}) as { ok?: unknown; servers?: unknown; error?: unknown }
  return {
    httpStatus: response.status,
    ok: record.ok === true,
    servers: Array.isArray(record.servers) ? record.servers as McpServerStatus[] : [],
    error: typeof record.error === 'string' ? record.error : undefined,
    body,
  }
}

/**
 * Read the status route until two consecutive reads agree.
 *
 * Mounting is asynchronous by design (each child fiber connects before the row
 * flips to `mounted: true`), so the first agreeing pair is the settled state.
 * Pass `until` whenever the pre-update answer would already be stable — an
 * empty effective list while the plugin is still reconciling, for example.
 * @param web - running web profile handle.
 * @param options.until - predicate every candidate read must satisfy first.
 * @returns the settled status read.
 */
export async function settledStatus(web: WebProfile, options: { until?: (read: StatusRead) => boolean } = {}): Promise<StatusRead> {
  return await pollStable(() => readStatus(web), {
    timeoutMs: 45_000,
    intervalMs: 250,
    description: 'settled status response',
    accept: options.until,
  })
}

/** Project settled rows to their names, in effective order. */
export function names(status: StatusRead): string[] {
  return status.servers.map((server) => server.serverName)
}

/** Find one settled row by name. */
export function row(status: StatusRead, serverName: string): McpServerStatus | undefined {
  return status.servers.find((server) => server.serverName === serverName)
}
