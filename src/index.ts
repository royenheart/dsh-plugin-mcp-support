/**
 * dsh-plugin-mcp-support — host half.
 *
 * Thin wrapper over the native dsh MCP bridge `@deepseek-ai/dsh-mcp-client`.
 * The wrapper owns two things the native bridge deliberately does not:
 *
 * - an `mcp-support` settings namespace so MCP servers can be configured and
 *   persisted through dsh settings, layered under the composition config;
 * - dynamic mount/dispose of one native mcp-client child fiber per effective
 *   server, re-synced whenever the settings section changes.
 *
 * It never re-implements connection, tool discovery, or reconnect logic.
 * It also serves a small session-agnostic status endpoint for the browser
 * half.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis'
import type { SettingsNamespace, SettingsScope } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import {
  mergeServers,
  normalizeServerConfigs,
  ServerConfig,
  serverConfigsEqual,
  SettingsSchema,
  validateUniqueServerNames,
} from './core/config.ts'
import type { McpServerConfig, McpSupportConfig, McpSupportSettings } from './core/config.ts'
import { summarizeServerStatus } from './core/status.ts'
import type { McpServerStatus } from './core/status.ts'

export {
  normalizeServerConfig,
  normalizeServerConfigs,
  mergeServers,
  servers,
  serverConfigsEqual,
  ServerConfig,
  SettingsSchema,
} from './core/config.ts'
export type {
  McpServerConfig,
  McpSupportConfig,
  McpSupportSettings,
  ReconnectConfig,
  StdioServerConfig,
  StreamableHttpServerConfig,
} from './core/config.ts'
export { summarizeServerStatus } from './core/status.ts'
export type { McpServerStatus } from './core/status.ts'

/** Cordis plugin name. */
export const name = 'mcp-support'

/** Required services: persisted settings + the native tool registry + the web route registry. */
export const inject = ['settings', 'tools', 'webServer']

/** Settings namespace (lowercase kebab-case). */
export const SETTINGS_NAMESPACE = 'mcp-support' as SettingsNamespace

/** Browser-facing status route (session-agnostic). */
export const STATUS_ENDPOINT = '/plugins/@royenheart/dsh-plugin-mcp-support/status'

/** Composition-time plugin config schema. */
export const Config = z.object({
  servers: z.array(ServerConfig).default([]),
})

interface MountedServer {
  fiber: Fiber
  config: McpServerConfig
}

/** Write a JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * Mount one native mcp-client child fiber per effective server and keep the
 * set in sync with the persisted settings list.
 *
 * @param ctx - host plugin context carrying settings, tools, and webServer.
 * @param config - optional composition-time server list.
 */
export async function apply(ctx: Context, config: McpSupportConfig = {}): Promise<void> {
  const composition = normalizeServerConfigs(config.servers)
  validateUniqueServerNames(composition)

  const settings: SettingsScope<McpSupportSettings> = ctx.settings.register(
    SETTINGS_NAMESPACE,
    SettingsSchema,
    {
      applies: 'live',
      // The persisted section has the same uniqueness contract as the
      // composition list; refuse a duplicate-name write at the settings seam
      // instead of storing a section that can never reconcile.
      validate: (value) => validateUniqueServerNames(value.servers),
    },
  )

  const mounted = new Map<string, MountedServer>()
  const mountErrors = new Map<string, string>()
  let disposed = false

  async function reconcile(next: McpServerConfig[]): Promise<void> {
    if (disposed) return
    const effective = mergeServers(composition, next)

    const removed: MountedServer[] = []
    for (const [serverName, entry] of mounted) {
      if (!effective.some((server) => server.serverName === serverName)) removed.push(entry)
    }
    if (removed.length > 0) {
      await Promise.all(removed.map(async (entry) => { await entry.fiber.dispose() }))
      for (const entry of removed) mounted.delete(entry.config.serverName)
    }
    if (disposed) return

    for (const server of effective) {
      const existing = mounted.get(server.serverName)
      if (existing && serverConfigsEqual(existing.config, server)) continue
      if (existing) {
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
        mountErrors.set(server.serverName, error instanceof Error ? error.message : String(error))
        throw error
      }
      if (disposed) return
    }
  }

  ctx.effect(() => {
    const disposeStatusRoute = ctx.webServer.register({
      kind: 'exact',
      path: STATUS_ENDPOINT,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const effective = mergeServers(composition, settings.get().servers)
        sendJson(res, 200, {
          ok: true,
          servers: summarizeServerStatus(effective, new Set(mounted.keys()), mountErrors),
        })
      },
    })

    const stop = settings.watch((next: McpSupportSettings) => reconcile(next.servers))
    return async () => {
      disposed = true
      stop()
      disposeStatusRoute()
      await Promise.all([...mounted.values()].map(async (entry) => { await entry.fiber.dispose() }))
      mounted.clear()
    }
  }, 'mcp-support.live-servers')

  await reconcile(settings.get().servers)
}
