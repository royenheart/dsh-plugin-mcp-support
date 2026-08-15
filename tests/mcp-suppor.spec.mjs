/**
 * Host-side tests for dsh-plugin-mcp-suppor.
 *
 * Uses a real cordis Context plus an in-memory settings provider and a stub
 * `tools` service. No MCP server is started: the empty-settings path proves
 * namespace registration, and the pure core helpers prove normalization and
 * merge behavior.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { SettingsProvider, settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  apply,
  inject,
  name,
  normalizeServerConfig,
  servers,
} from '../lib/index.js'

class MemorySettings extends SettingsProvider {
  doc = {}
  get writable() { return true }
  load() { return Promise.resolve(structuredClone(this.doc)) }
  persist(ns, section) {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

class MockTools extends Service {
  constructor(ctx) {
    super(ctx, 'tools')
  }
}

const settingsPlugin = {
  name: 'memory-settings',
  inject: [],
  apply(ctx) { ctx.plugin(MemorySettings) },
}

const toolsPlugin = {
  name: 'mock-tools',
  inject: [],
  apply(ctx) { ctx.plugin(MockTools) },
}

async function boot(config) {
  const ctx = new Context()
  await ctx.plugin(settingsPlugin)
  await ctx.plugin(toolsPlugin)
  await ctx.plugin({ name, inject, apply }, config)
  return ctx
}

test('empty config registers the mcp-suppor settings namespace', async () => {
  const ctx = await boot()
  const value = ctx.settings.get(settingsNamespace('mcp-suppor'))
  assert.deepEqual(value, { servers: [] })
})

test('duplicate serverName in composition throws a clear error', async () => {
  await assert.rejects(
    boot({
      servers: [
        { transport: 'stdio', serverName: 'dup', command: 'node a' },
        { transport: 'stdio', serverName: 'dup', command: 'node b' },
      ],
    }),
    /duplicate serverName/,
  )
})

test('normalizeServerConfig accepts stdio and fills defaults', () => {
  const config = normalizeServerConfig({
    transport: 'stdio',
    serverName: 'my-stdio',
    command: 'node',
  })
  assert.equal(config.transport, 'stdio')
  assert.equal(config.serverName, 'my-stdio')
  assert.equal(config.command, 'node')
  assert.deepEqual(config.args, [])
  assert.deepEqual(config.env, {})
  assert.equal(config.cwd, '')
  assert.equal(config.toolCallTimeoutMs, 60_000)
  assert.equal(config.failOnStartupError, false)
})

test('normalizeServerConfig accepts streamable-http and fills defaults', () => {
  const config = normalizeServerConfig({
    transport: 'streamable-http',
    serverName: 'my-http',
    url: 'http://localhost:3000/mcp',
  })
  assert.equal(config.transport, 'streamable-http')
  assert.equal(config.serverName, 'my-http')
  assert.equal(config.url, 'http://localhost:3000/mcp')
  assert.deepEqual(config.headers, {})
  assert.equal(config.toolCallTimeoutMs, 60_000)
  assert.equal(config.failOnStartupError, false)
})

test('normalizeServerConfig rejects invalid serverName', () => {
  assert.throws(
    () => normalizeServerConfig({ transport: 'stdio', serverName: 'bad name!', command: 'node' }),
  )
})

test('servers helper merges composition first with settings overriding by serverName', () => {
  const effective = servers(
    [
      { transport: 'stdio', serverName: 'comp-only', command: 'node a' },
      { transport: 'stdio', serverName: 'overridden', command: 'node a' },
    ],
    [
      { transport: 'stdio', serverName: 'overridden', command: 'node b' },
      { transport: 'streamable-http', serverName: 'settings-only', url: 'http://localhost:3000/mcp' },
    ],
  )
  assert.deepEqual(effective.map((server) => server.serverName), [
    'comp-only',
    'overridden',
    'settings-only',
  ])
  assert.equal(effective.find((server) => server.serverName === 'overridden').command, 'node b')
})
