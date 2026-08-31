/**
 * Host tests: config helpers, status HTTP, live native mcp-client mount,
 * settings-driven remount, and fail-on-startup.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  apply,
  inject,
  name,
  normalizeServerConfig,
  servers,
  SETTINGS_NAMESPACE,
  STATUS_ENDPOINT,
  summarizeServerStatus,
} from '../src/index.ts'

const fixtureServer = fileURLToPath(new URL('./fixture-mcp-server.mjs', import.meta.url))

function fixtureServerConfig(serverName = 'fixture') {
  return {
    transport: 'stdio',
    serverName,
    command: process.execPath,
    args: [fixtureServer],
    cwd: process.cwd(),
    failOnStartupError: true,
    toolCallTimeoutMs: 15_000,
  }
}

class MemorySettings extends SettingsProvider {
  doc = {}
  get writable() { return true }
  load() { return Promise.resolve(structuredClone(this.doc)) }
  persist(ns, section) {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

class MockWebServer extends Service {
  routes = []
  constructor(ctx) {
    super(ctx, 'webServer')
  }
  register(route) {
    this.routes.push(route)
    return () => {
      const at = this.routes.indexOf(route)
      if (at !== -1) this.routes.splice(at, 1)
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function invokeRoute(route, method = 'GET') {
  let status = 0
  let body = ''
  const res = {
    writeHead(code) { status = code },
    end(chunk) { body = chunk === undefined ? '' : String(chunk) },
  }
  route.handler({ method }, res)
  return { status, json: body === '' ? undefined : JSON.parse(body) }
}

async function bootEmpty() {
  const ctx = new Context()
  await ctx.plugin({ name: 'memory-settings', inject: [], apply: (c) => { c.plugin(MemorySettings) } })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin({ name: 'mock-webserver', inject: [], apply: (c) => { c.plugin(MockWebServer) } })
  await ctx.plugin({ name, inject, apply }, { servers: [] })
  return ctx
}

async function bootWithServers(serverList) {
  const ctx = new Context()
  await ctx.plugin({ name: 'memory-settings', inject: [], apply: (c) => { c.plugin(MemorySettings) } })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin({ name: 'mock-webserver', inject: [], apply: (c) => { c.plugin(MockWebServer) } })
  await ctx.plugin({ name, inject, apply }, { servers: serverList })
  return ctx
}

test('empty config registers the mcp-support settings namespace', async () => {
  const ctx = await bootEmpty()
  const value = ctx.settings.describe().find(entry => entry.ns === SETTINGS_NAMESPACE)?.value
  assert.deepEqual(value, { servers: [] })
  await ctx.fiber.dispose()
})

test('empty config registers the status route', async () => {
  const ctx = await bootEmpty()
  const route = ctx.webServer.routes.find((entry) => entry.path === STATUS_ENDPOINT)
  assert.ok(route)
  assert.equal(route.kind, 'exact')
  const get = invokeRoute(route, 'GET')
  assert.equal(get.status, 200)
  assert.equal(get.json.ok, true)
  assert.deepEqual(get.json.servers, [])
  const post = invokeRoute(route, 'POST')
  assert.equal(post.status, 405)
  assert.equal(post.json.ok, false)
  await ctx.fiber.dispose()
})

test('duplicate serverName in composition throws a clear error', async () => {
  await assert.rejects(
    bootWithServers([
      { transport: 'stdio', serverName: 'dup', command: 'node a' },
      { transport: 'stdio', serverName: 'dup', command: 'node b' },
    ]),
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

test('summarizeServerStatus reports mounted state and last error', () => {
  const effective = servers(
    [
      { transport: 'stdio', serverName: 'mounted', command: 'node a' },
      { transport: 'streamable-http', serverName: 'failed', url: 'http://localhost:3000/mcp' },
      { transport: 'stdio', serverName: 'pending', command: 'node b' },
    ],
    [],
  )
  const status = summarizeServerStatus(
    effective,
    new Set(['mounted']),
    new Map([['failed', 'connect ECONNREFUSED']]),
  )
  assert.deepEqual(status, [
    { serverName: 'mounted', transport: 'stdio', mounted: true },
    { serverName: 'failed', transport: 'streamable-http', mounted: false, error: 'connect ECONNREFUSED' },
    { serverName: 'pending', transport: 'stdio', mounted: false },
  ])
})

test('live stdio MCP server mounts native tools and reports mounted status', async () => {
  const ctx = await bootWithServers([fixtureServerConfig()])
  const names = ctx.tools.schemas().map(schema => schema.name)
  assert.ok(names.includes('mcp__fixture__echo'), `tools were ${names.join(', ')}`)

  const route = ctx.webServer.routes.find((entry) => entry.path === STATUS_ENDPOINT)
  const status = invokeRoute(route, 'GET')
  assert.equal(status.status, 200)
  assert.deepEqual(status.json.servers, [
    { serverName: 'fixture', transport: 'stdio', mounted: true },
  ])
  await ctx.fiber.dispose()
})

test('settings update remounts: add a server, then drop it', async () => {
  const ctx = await bootEmpty()
  assert.equal(ctx.tools.schemas().some(schema => schema.name.startsWith('mcp__live__')), false)

  await ctx.settings.update(SETTINGS_NAMESPACE, { servers: [fixtureServerConfig('live')] })
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (ctx.tools.schemas().some(schema => schema.name === 'mcp__live__echo')) break
    await sleep(50)
  }
  assert.ok(ctx.tools.schemas().some(schema => schema.name === 'mcp__live__echo'))

  const route = ctx.webServer.routes.find((entry) => entry.path === STATUS_ENDPOINT)
  assert.equal(invokeRoute(route).json.servers[0].mounted, true)

  await ctx.settings.replace(SETTINGS_NAMESPACE, { servers: [] })
  const dropDeadline = Date.now() + 20_000
  while (Date.now() < dropDeadline) {
    if (!ctx.tools.schemas().some(schema => schema.name === 'mcp__live__echo')) break
    await sleep(50)
  }
  assert.equal(ctx.tools.schemas().some(schema => schema.name === 'mcp__live__echo'), false)
  assert.deepEqual(invokeRoute(route).json.servers, [])
  await ctx.fiber.dispose()
})

test('failOnStartupError rejects plugin activation for a dead stdio command', async () => {
  await assert.rejects(
    bootWithServers([{
      transport: 'stdio',
      serverName: 'dead',
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
      failOnStartupError: true,
      toolCallTimeoutMs: 5_000,
    }]),
    /mcp-client|initial connection|failed/i,
  )
})
