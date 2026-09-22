/**
 * Host tests: config helpers, the volatile settings seam, status HTTP, live
 * native mcp-client mounts, profile-layer re-sync, and fail-on-startup.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  apply,
  Config,
  inject,
  name,
  normalizeServerConfig,
  readServerList,
  selectEffectiveServers,
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

class MockConfigEditor extends Service {
  layers = []
  constructor(ctx) {
    super(ctx, 'configEditor')
  }
  configuration() {
    return this.layers.map(layer => ({
      entry: { options: { id: layer.entryId } },
      inherited: layer.inherited,
      override: layer.override,
    }))
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

async function mountWebServer(ctx) {
  await ctx.plugin({ name: 'mock-webserver', inject: [], apply: (c) => { c.plugin(MockWebServer) } })
}

async function boot({ serverList = [], rows = [], webServer = true } = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (webServer) await mountWebServer(ctx)
  await ctx.plugin({ name: 'mock-config-editor', inject: [], apply: (c) => { c.plugin(MockConfigEditor) } })
  const editor = ctx.get('configEditor')
  editor.layers = rows
  await ctx.plugin({ name, inject, apply, Config }, { servers: serverList })
  return ctx
}

async function waitFor(predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(50)
  }
  return predicate()
}

test('plugin Config exposes servers as a volatile live field', () => {
  const serversField = Config.dict.servers
  assert.equal(serversField.meta.volatile, true)
  assert.deepEqual(serversField.meta.default, [])
})

test('readServerList unwraps the volatile reference and plain values', () => {
  const parsed = Config({ servers: [fixtureServerConfig('live')] })
  assert.deepEqual(readServerList(parsed).map(server => server.serverName), ['live'])
  assert.deepEqual(
    readServerList({ servers: [fixtureServerConfig('live')] }).map(server => server.serverName),
    ['live'],
  )
})

// Regression: a volatile snapshot is deep-frozen, and Schemastery's dict
// validation writes into the dict it validates, so a non-empty `env` or
// `headers` read straight out of the snapshot used to reject a valid config.
test('readServerList accepts a frozen volatile snapshot with env and headers', () => {
  const stdio = Config({
    servers: [{
      transport: 'stdio',
      serverName: 'stdio-env',
      command: 'node',
      args: ['--flag'],
      env: { MCP_TOKEN: 'secret' },
    }],
  })
  assert.equal(Object.isFrozen(stdio.servers.get()[0].env), true)
  const [stdioServer] = readServerList(stdio)
  assert.equal(stdioServer.serverName, 'stdio-env')
  assert.deepEqual(stdioServer.env, { MCP_TOKEN: 'secret' })
  assert.deepEqual(stdioServer.args, ['--flag'])

  const http = Config({
    servers: [{
      transport: 'streamable-http',
      serverName: 'http-headers',
      url: 'http://localhost:3000/mcp',
      headers: { Authorization: 'Bearer secret' },
    }],
  })
  assert.equal(Object.isFrozen(http.servers.get()[0].headers), true)
  assert.deepEqual(readServerList(http)[0].headers, { Authorization: 'Bearer secret' })
})

test('selectEffectiveServers layers settings over composition keyed by serverName', () => {
  const composition = [
    { transport: 'stdio', serverName: 'comp-only', command: 'node a' },
    { transport: 'stdio', serverName: 'overridden', command: 'node a' },
  ]
  const settings = [
    { transport: 'stdio', serverName: 'overridden', command: 'node b' },
    { transport: 'streamable-http', serverName: 'settings-only', url: 'http://localhost:3000/mcp' },
  ]
  const rows = [{ entryId: SETTINGS_NAMESPACE, inherited: { servers: composition }, override: { servers: settings } }]
  const effective = selectEffectiveServers(SETTINGS_NAMESPACE, [], rows)
  assert.deepEqual(effective.map(server => server.serverName), [
    'comp-only',
    'overridden',
    'settings-only',
  ])
  assert.equal(effective.find(server => server.serverName === 'overridden').command, 'node b')
  // No profile row for this entry: the resolved list is authoritative.
  assert.deepEqual(
    selectEffectiveServers(SETTINGS_NAMESPACE, [{ transport: 'stdio', serverName: 'resolved', command: 'node' }], [])
      .map(server => server.serverName),
    ['resolved'],
  )
})

test('empty config registers the status route', async () => {
  const ctx = await boot()
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

// Regression: the migration boot probe mounts `dsh-base` + `dsh-headless`,
// which has no `webServer`. A required injection there left the entry pending
// forever and failed the boot; the status route must ride an optional child.
test('activates without a webServer and still mounts configured servers', async () => {
  assert.ok(!inject.includes('webServer'))
  const ctx = await boot({ serverList: [fixtureServerConfig('headless')], webServer: false })
  assert.equal(ctx.get('webServer'), undefined)
  assert.ok(ctx.tools.schemas().some(schema => schema.name === 'mcp__headless__echo'))
  await ctx.fiber.dispose()
})

test('a webServer mounted after activation still receives the status route', async () => {
  const ctx = await boot({ serverList: [], webServer: false })
  assert.equal(ctx.get('webServer'), undefined)
  await mountWebServer(ctx)
  assert.ok(await waitFor(() => ctx.webServer.routes.some((entry) => entry.path === STATUS_ENDPOINT)))
  const route = ctx.webServer.routes.find((entry) => entry.path === STATUS_ENDPOINT)
  const response = invokeRoute(route, 'GET')
  assert.equal(response.status, 200)
  assert.deepEqual(response.json.servers, [])
  await ctx.fiber.dispose()
})

// Regression: `configEditor.configuration()` reports every profile row. Only
// this plugin's own row may be interpolated — a sibling row's expression can
// reference a service this plugin does not inject (the headless probe mounts
// `headless-runner`, whose config reads `ctx.headlessStartup.task`) and
// evaluating it here used to fail the boot.
test('sibling profile rows with foreign !!js expressions do not break activation', async () => {
  const ctx = await boot({
    serverList: [fixtureServerConfig('foreign')],
    rows: [
      { entryId: 'headless-runner', inherited: { task: { __jsExpr: 'ctx.headlessStartup.task' } }, override: {} },
      { entryId: SETTINGS_NAMESPACE, inherited: { servers: [fixtureServerConfig('foreign')] }, override: {} },
    ],
  })
  assert.ok(ctx.tools.schemas().some(schema => schema.name === 'mcp__foreign__echo'))
  await ctx.fiber.dispose()
})

test('duplicate serverName in composition throws a clear error', async () => {
  await assert.rejects(
    boot({
      serverList: [
        { transport: 'stdio', serverName: 'dup', command: 'node a' },
        { transport: 'stdio', serverName: 'dup', command: 'node b' },
      ],
    }),
    /duplicate serverName/,
  )
})

test('duplicate serverName in the settings layer fails activation', async () => {
  await assert.rejects(
    boot({
      serverList: [fixtureServerConfig('live')],
      rows: [{
        entryId: SETTINGS_NAMESPACE,
        inherited: { servers: [] },
        override: {
          servers: [
            { transport: 'stdio', serverName: 'dup', command: 'node a' },
            { transport: 'stdio', serverName: 'dup', command: 'node b' },
          ],
        },
      }],
    }),
    /duplicate serverName/,
  )
})

test('a committed update with duplicate serverName is reported on the status route', async () => {
  const ctx = await boot({ serverList: [fixtureServerConfig('live')] })
  const editor = ctx.get('configEditor')
  const route = ctx.webServer.routes.find((entry) => entry.path === STATUS_ENDPOINT)
  assert.equal(invokeRoute(route, 'GET').status, 200)

  editor.layers = [{
    entryId: SETTINGS_NAMESPACE,
    inherited: { servers: [] },
    override: {
      servers: [
        { transport: 'stdio', serverName: 'dup', command: 'node a' },
        { transport: 'stdio', serverName: 'dup', command: 'node b' },
      ],
    },
  }]
  ctx.emit('loader/volatile-update', [['servers']])
  assert.ok(await waitFor(() => invokeRoute(route, 'GET').status === 500))
  const response = invokeRoute(route, 'GET')
  assert.match(response.json.error, /duplicate serverName/)
  await ctx.fiber.dispose()
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
  assert.equal(config.maxInstructionBytes, 32_768)
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
  assert.equal(config.maxInstructionBytes, 32_768)
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
  const ctx = await boot({ serverList: [fixtureServerConfig()] })
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

test('profile settings layer re-syncs mounts on a committed volatile update', async () => {
  const ctx = await boot({ serverList: [] })
  const editor = ctx.get('configEditor')
  assert.equal(ctx.tools.schemas().some(schema => schema.name.startsWith('mcp__live__')), false)

  editor.layers = [{
    entryId: SETTINGS_NAMESPACE,
    inherited: { servers: [] },
    override: { servers: [fixtureServerConfig('live')] },
  }]
  ctx.emit('loader/volatile-update', [['servers']])
  assert.ok(await waitFor(() => ctx.tools.schemas().some(schema => schema.name === 'mcp__live__echo')))

  const route = ctx.webServer.routes.find((entry) => entry.path === STATUS_ENDPOINT)
  assert.equal(invokeRoute(route).json.servers[0].mounted, true)

  editor.layers = [{
    entryId: SETTINGS_NAMESPACE,
    inherited: { servers: [] },
    override: { servers: [] },
  }]
  ctx.emit('loader/volatile-update', [['servers']])
  assert.ok(await waitFor(() => !ctx.tools.schemas().some(schema => schema.name === 'mcp__live__echo')))
  assert.deepEqual(invokeRoute(route).json.servers, [])
  await ctx.fiber.dispose()
})

test('composition servers survive a settings-only volatile update', async () => {
  const ctx = await boot({ serverList: [fixtureServerConfig('composition')] })
  const editor = ctx.get('configEditor')
  assert.ok(ctx.tools.schemas().some(schema => schema.name === 'mcp__composition__echo'))

  editor.layers = [{
    entryId: SETTINGS_NAMESPACE,
    inherited: { servers: [fixtureServerConfig('composition')] },
    override: { servers: [fixtureServerConfig('settings')] },
  }]
  ctx.emit('loader/volatile-update', [['servers']])
  assert.ok(await waitFor(() => ctx.tools.schemas().some(schema => schema.name === 'mcp__settings__echo')))
  assert.ok(ctx.tools.schemas().some(schema => schema.name === 'mcp__composition__echo'))
  await ctx.fiber.dispose()
})

// Regression: profile patch layers keep `!!js` expression nodes unevaluated.
// The plugin must evaluate them with the Loader's own helper before the server
// schema normalizes a layer, exactly as the Loader does before mounting the row.
test('profile layers evaluate !!js expressions like the Loader', async () => {
  const ctx = await boot({
    serverList: [],
    rows: [{
      entryId: SETTINGS_NAMESPACE,
      inherited: {
        servers: [{
          transport: 'stdio',
          serverName: 'expr',
          command: { __jsExpr: 'process.execPath' },
          args: [fixtureServer],
          env: { MCP_EXPR_TOKEN: { __jsExpr: "'from-expression'" } },
          toolCallTimeoutMs: 15_000,
          failOnStartupError: true,
        }],
      },
      override: {
        servers: [{
          transport: 'streamable-http',
          serverName: 'expr-settings',
          url: { __jsExpr: "'http://127.0.0.1:9/mcp'" },
          headers: { Authorization: { __jsExpr: "'Bearer ' + 'token'" } },
          failOnStartupError: false,
          toolCallTimeoutMs: 5_000,
        }],
      },
    }],
  })
  assert.ok(ctx.tools.schemas().some(schema => schema.name === 'mcp__expr__echo'))
  const route = ctx.webServer.routes.find((entry) => entry.path === STATUS_ENDPOINT)
  assert.deepEqual(invokeRoute(route).json.servers.map(server => server.serverName), ['expr', 'expr-settings'])
  await ctx.fiber.dispose()
})

test('failOnStartupError rejects plugin activation for a dead stdio command', async () => {
  await assert.rejects(
    boot({
      serverList: [{
        transport: 'stdio',
        serverName: 'dead',
        command: process.execPath,
        args: ['-e', 'process.exit(1)'],
        failOnStartupError: true,
        toolCallTimeoutMs: 5_000,
      }],
    }),
    /mcp-client|initial connection|failed/i,
  )
})
