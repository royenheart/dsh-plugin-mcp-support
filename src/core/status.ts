/**
 * Pure MCP status shaping for the browser-facing status endpoint.
 *
 * Deliberately free of cordis imports so it stays trivially unit-testable.
 */
import type { McpServerConfig } from './config.ts'

/** Wire shape returned by the `/plugins/@royenheart/dsh-plugin-mcp-support/status` endpoint. */
export interface McpServerStatus {
  serverName: string
  transport: McpServerConfig['transport']
  mounted: boolean
  error?: string
}

/**
 * Map the effective server list to browser-consumable status rows.
 *
 * @param effective - the merged composition + settings server list.
 * @param mountedNames - names of currently mounted native child fibers.
 * @param mountErrors - last mount error message per server name.
 * @returns one status row per effective server, in effective order.
 */
export function summarizeServerStatus(
  effective: readonly McpServerConfig[],
  mountedNames: ReadonlySet<string>,
  mountErrors: ReadonlyMap<string, string>,
): McpServerStatus[] {
  return effective.map((server) => {
    const status: McpServerStatus = {
      serverName: server.serverName,
      transport: server.transport,
      mounted: mountedNames.has(server.serverName),
    }
    const error = mountErrors.get(server.serverName)
    if (error !== undefined) status.error = error
    return status
  })
}
