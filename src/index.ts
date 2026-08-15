/**
 * dsh-plugin-mcp-suppor — host half.
 *
 * Thin wrapper over the native dsh MCP bridge `@deepseek-ai/dsh-mcp-client`.
 * The wrapper owns two things the native bridge deliberately does not:
 *
 * - an `mcp-suppor` settings namespace so MCP servers can be configured and
 *   persisted through dsh settings, layered under the composition config;
 * - dynamic mount/dispose of one native mcp-client child fiber per effective
 *   server, re-synced whenever the settings section changes.
 *
 * It never re-implements connection, tool discovery, or reconnect logic.
 */
import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
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
import type { McpServerConfig, McpSupporConfig } from './core/config.ts'

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
  McpSupporConfig,
  McpSupporSettings,
  ReconnectConfig,
  StdioServerConfig,
  StreamableHttpServerConfig,
} from './core/config.ts'

/** Cordis plugin name. */
export const name = 'mcp-suppor'

/** Required services: persisted settings + the native tool registry. */
export const inject = ['settings', 'tools']

/** Settings namespace (lowercase kebab-case). */
export const SETTINGS_NAMESPACE = settingsNamespace('mcp-suppor')

/** Composition-time plugin config schema. */
export const Config = z.object({
  servers: z.array(ServerConfig).default([]),
})

interface MountedServer {
  fiber: Fiber
  config: McpServerConfig
}

/**
 * Mount one native mcp-client child fiber per effective server and keep the
 * set in sync with the persisted settings list.
 *
 * @param ctx - host plugin context carrying settings and tools.
 * @param config - optional composition-time server list.
 */
export async function apply(ctx: Context, config: McpSupporConfig = {}): Promise<void> {
  const composition = normalizeServerConfigs(config.servers)
  validateUniqueServerNames(composition)

  const settings = ctx.settings.register(
    settingsNamespace('mcp-suppor'),
    SettingsSchema,
    { applies: 'live' },
  )

  const mounted = new Map<string, MountedServer>()
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
      const child = ctx.plugin(childPlugin, server)
      mounted.set(server.serverName, { fiber: child, config: server })
      if (disposed) {
        void child.dispose()
        mounted.delete(server.serverName)
        return
      }
      try {
        await child
      } catch (error) {
        mounted.delete(server.serverName)
        throw error
      }
      if (disposed) return
    }
  }

  ctx.effect(() => {
    const stop = settings.watch((next) => reconcile(next.servers))
    return async () => {
      disposed = true
      stop()
      await Promise.all([...mounted.values()].map(async (entry) => { await entry.fiber.dispose() }))
      mounted.clear()
    }
  }, 'mcp-suppor.live-servers')

  await reconcile(settings.get().servers)
}
