/**
 * dsh-plugin-mcp-support — host half.
 *
 * Thin wrapper over the native dsh MCP bridge `@deepseek-ai/dsh-mcp-client`.
 * The wrapper owns two things the native bridge deliberately does not:
 *
 * - one `servers` config list that stays live editable through the owning
 *   profile: the entry config inherited from the bundle patch is the
 *   composition layer, the profile patch override (what the dsh settings
 *   forms write, and what a legacy `settings.yaml` section imports into) is
 *   the persisted settings layer, and the wrapper layers the two by
 *   `serverName`;
 * - dynamic mount/dispose of one native mcp-client child fiber per effective
 *   server, re-synced whenever the Loader commits a volatile config update.
 *
 * It never re-implements connection, tool discovery, or reconnect logic.
 * It also serves a small session-agnostic status endpoint for the browser
 * half.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Fiber, Plugin, Volatile } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
// Type-only: `ctx.configEditor` (profile config layers) and the web route registry.
import type {} from '@deepseek-ai/dsh-config-editor'
import type {} from '@deepseek-ai/dsh-host-webserver'
// `interpolate` evaluates `!!js` config expressions exactly as the Loader does
// before it hands a row's config to its plugin; the Loader's live
// `loader/volatile-update` event also arrives through this package.
import { interpolate } from '@deepseek-ai/cordis-plugin-loader'
import { isVolatile } from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import {
  mergeServers,
  normalizeServerConfigs,
  ServerConfig,
  serverConfigsEqual,
  validateUniqueServerNames,
} from './core/config.ts'
import type { McpServerConfig, McpSupportConfig } from './core/config.ts'
import { summarizeServerStatus } from './core/status.ts'
import type { McpServerStatus } from './core/status.ts'

export {
  normalizeServerConfig,
  normalizeServerConfigs,
  mergeServers,
  servers,
  serverConfigsEqual,
  ServerConfig,
} from './core/config.ts'
export type {
  McpServerConfig,
  McpSupportConfig,
  ReconnectConfig,
  StdioServerConfig,
  StreamableHttpServerConfig,
} from './core/config.ts'
export { summarizeServerStatus } from './core/status.ts'
export type { McpServerStatus } from './core/status.ts'

/** Cordis plugin name. */
export const name = 'mcp-support'

/**
 * Required services: the native tool registry. The web route registry is
 * attached optionally in `apply`: a headless profile mounts no HTTP server, so
 * a required `webServer` would leave this entry pending forever instead of
 * mounting the configured MCP servers.
 */
export const inject = ['tools']

/**
 * Profile entry id the bundled patch declares. The same id addresses the
 * plugin's persisted settings layer: the profile patch override written by
 * the dsh settings forms, and the legacy `settings.yaml` section the settings
 * service imports once.
 */
export const SETTINGS_NAMESPACE = 'mcp-support' as SettingsNamespace

/** Browser-facing status route (session-agnostic). */
export const STATUS_ENDPOINT = '/plugins/@royenheart/dsh-plugin-mcp-support/status'

/** Runtime plugin config: the Loader commits volatile fields into stable references. */
export interface McpSupportPluginConfig {
  /** Effective server list of the owning profile entry. */
  servers: Volatile<McpServerConfig[]>
}

/**
 * Plugin config schema. `servers` is volatile so the official settings forms
 * own persistence and a committed update re-syncs the mounted set without
 * remounting this plugin.
 */
export const Config = z.object({
  servers: z.array(ServerConfig).default([]).volatile(),
}) as unknown as z<McpSupportConfig, McpSupportPluginConfig>

/** One profile entry's config layers reported by the profile config editor. */
export interface ConfigLayerRow {
  /** Loader entry id (the row id the bundle patch declares). */
  entryId: string
  /** Composition layer: the row config inherited from the bundle patch. */
  inherited: Record<string, unknown>
  /** Persisted settings layer: the profile patch override. */
  override: Record<string, unknown>
}

interface MountedServer {
  fiber: Fiber
  config: McpServerConfig
}

/** Write a JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Read the live server list from the volatile reference (plain values in embedded mounts). */
export function readServerList(config: McpSupportPluginConfig): McpServerConfig[] {
  const value: unknown = config.servers
  return normalizeServerConfigs(isVolatile(value) ? value.get() : value)
}

/**
 * Layer the persisted settings list over the composition list, keyed by
 * `serverName`: a settings server with the same name overrides the
 * composition entry, and settings-only servers are appended.
 *
 * Falls back to the resolved list when the profile config editor does not
 * report the running entry (embedded mounts outside the Loader).
 *
 * @param entryId - profile entry id the running plugin was mounted under.
 * @param resolved - the entry's resolved `servers` value.
 * @param rows - profile config layers reported by `ctx.configEditor`.
 * @returns the effective server list.
 */
export function selectEffectiveServers(
  entryId: string,
  resolved: readonly McpServerConfig[],
  rows: readonly ConfigLayerRow[],
): McpServerConfig[] {
  const row = rows.find(candidate => candidate.entryId === entryId)
  if (row === undefined) return [...resolved]
  return mergeServers(
    normalizeServerConfigs(row.inherited.servers),
    normalizeServerConfigs(row.override.servers),
  )
}

/**
 * Mount one native mcp-client child fiber per effective server and keep the
 * set in sync with the profile's committed config layers.
 *
 * @param ctx - host plugin context carrying the tool registry and web routes.
 * @param config - volatile server list committed by the Loader.
 */
export async function apply(ctx: Context, config: McpSupportPluginConfig): Promise<void> {
  const entryId = ctx.fiber.entry?.options.id ?? SETTINGS_NAMESPACE

  /** Effective server list: the profile's persisted settings layer over the composition layer. */
  function effectiveServers(): McpServerConfig[] {
    const resolved = readServerList(config)
    const editor = ctx.get('configEditor')
    if (editor === undefined) return resolved
    const own = editor.configuration().find(row => row.entry.options.id === entryId)
    if (own === undefined) return resolved
    // Profile layers carry `!!js` expression nodes unevaluated; the Loader
    // evaluates them with this same helper before it mounts a row, so both of
    // this row's layers are evaluated before the server schema normalizes
    // them. Only this row is interpolated: other rows' expressions reference
    // services this plugin does not inject (`headlessStartup`, `webStartup`,
    // …) and evaluating them here would fail activation.
    const layers: ConfigLayerRow[] = [{
      entryId,
      inherited: interpolate(ctx, own.inherited) as Record<string, unknown>,
      override: interpolate(ctx, own.override) as Record<string, unknown>,
    }]
    return selectEffectiveServers(entryId, resolved, layers)
  }

  const mounted = new Map<string, MountedServer>()
  const mountErrors = new Map<string, string>()
  let disposed = false
  let queue: Promise<void> = Promise.resolve()

  async function reconcile(next: McpServerConfig[], origin: 'activation' | 'update'): Promise<void> {
    if (disposed) return
    validateUniqueServerNames(next)

    const removed: MountedServer[] = []
    for (const [serverName, entry] of mounted) {
      if (!next.some(server => server.serverName === serverName)) removed.push(entry)
    }
    if (removed.length > 0) {
      await Promise.all(removed.map(async (entry) => { await entry.fiber.dispose() }))
      for (const entry of removed) mounted.delete(entry.config.serverName)
    }
    if (disposed) return

    for (const server of next) {
      const existing = mounted.get(server.serverName)
      if (existing !== undefined && serverConfigsEqual(existing.config, server)) continue
      if (existing !== undefined) {
        await existing.fiber.dispose()
        mounted.delete(server.serverName)
      }
      if (disposed) return

      // The native package resolves its own @deepseek-ai/cordis type copy, so
      // the exported apply's static Context differs from the runtime Context
      // our host bundle shares. Cast the object (not the function) back to the
      // local cordis plugin shape; runtime identity is unaffected.
      const childPlugin = {
        name: mcpClient.name,
        inject: mcpClient.inject,
        apply: mcpClient.apply,
      } as unknown as Plugin.Object<McpServerConfig>
      try {
        const child = ctx.plugin(childPlugin, server)
        mounted.set(server.serverName, { fiber: child, config: server })
        if (disposed) {
          void child.dispose()
          mounted.delete(server.serverName)
          return
        }
        await child
        mountErrors.delete(server.serverName)
      } catch (error) {
        mounted.delete(server.serverName)
        const message = error instanceof Error ? error.message : String(error)
        mountErrors.set(server.serverName, message)
        if (origin === 'activation') throw error
        ctx.logger.warn('mcp-support: failed to mount MCP server "%s": %s', server.serverName, message)
      }
      if (disposed) return
    }
  }

  /** Queue one reconcile for a committed volatile config update. */
  function schedule(): void {
    queue = queue
      .then(async () => { await reconcile(effectiveServers(), 'update') })
      .catch((error: unknown) => {
        if (disposed) return
        ctx.logger.error(error)
      })
  }

  /** Answer one status request from the mounted set. */
  function statusHandler(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    let servers: McpServerStatus[]
    try {
      servers = summarizeServerStatus(effectiveServers(), new Set(mounted.keys()), mountErrors)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    sendJson(res, 200, { ok: true, servers })
  }

  // The status route is a web-surface capability, not a precondition of the
  // MCP mounts: a headless profile mounts no `webServer`, so the route is
  // registered in an optional child fiber that activates whenever the service
  // is (or becomes) available — the same seam the harness's own web carriers
  // use. The child is scoped to this plugin fiber, so the route disposes with
  // it.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: STATUS_ENDPOINT,
        handler: statusHandler,
      }),
      'mcp-support: status route',
    )
  })

  ctx.effect(() => {
    ctx.on('loader/volatile-update', () => { schedule() })
    return async () => {
      disposed = true
      await Promise.all([...mounted.values()].map(async (entry) => { await entry.fiber.dispose() }))
      mounted.clear()
    }
  }, 'mcp-support.live-servers')

  await reconcile(effectiveServers(), 'activation')
}
