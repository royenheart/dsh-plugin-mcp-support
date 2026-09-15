/**
 * C3 (headless half) + C7 (config union) — CLI boot surfaces.
 *
 * Feature ledger rows: `headless-activation`, `config-union-stdio`,
 * `config-union-streamable-http`, `config-validation`.
 *
 * No browser surface exists in this spec, so the console/pageerror tripwire is
 * replaced by `assertCliTripwire`: every process output is checked for
 * unexpected internal errors, and the scenario's own expected diagnostics are
 * passed explicitly.
 *
 * The headless profile ships no `webServer` service. The plugin must still
 * activate and mount its servers there — the regression this migration fixed —
 * and the fixture marker proves a real child process was spawned and asked for
 * its tool list.
 */
import path from 'node:path'
import { test, expect, assertCliTripwire } from '../harness/test'
import { materializeScenarioHome } from '../harness/dsh-home'
import { runDsh } from '../harness/dsh-process'
import { deadStdioFixture, stdioFixture } from '../harness/config'
import { waitForMarkerLine } from '../harness/mcp-fixture'
import { tempRoot } from '../harness/paths'

const HEADLESS = ['--profile', 'headless'] as const

function scenarioMarkers(id: string): string {
  return path.join(tempRoot(), 'scenarios', id, 'markers')
}

function probeHome(id: string, options: { servers?: unknown[] | null; settings?: Record<string, unknown> | null } = {}) {
  return materializeScenarioHome({
    id,
    profile: 'headless',
    servers: options.servers ?? null,
    settings: options.settings ?? null,
  })
}

test('activates and mounts MCP servers in a profile that provides no webServer service', async () => {
  const id = 'headless-activation'
  const marker = path.join(scenarioMarkers(id), 'fixture.txt')
  const home = probeHome(id, { servers: [stdioFixture('fixture', { markerFile: marker })] })

  const run = await runDsh(home.home, [...HEADLESS, 'e2e headless mount probe'], { timeoutMs: 150_000 })
  expect(run.timedOut, `headless boot timed out:\n${run.output}`).toBe(false)
  expect(run.output, 'the row must not stay pending on webServer').not.toMatch(/mcp-support[^\n]*(pending|did not activate)/i)

  const lines = await waitForMarkerLine(marker, /^method tools\/list$/, 30_000)
  expect(lines).toContain('ready')
  expect(lines).toContain('method initialize')
  assertCliTripwire(run.output)
})

test('the composed profile tree carries the plugin row and its composition config', async () => {
  const id = 'headless-dump'
  const home = probeHome(id, { servers: [stdioFixture('fixture', { markerFile: path.join(scenarioMarkers(id), 'fixture.txt') })] })
  const run = await runDsh(home.home, [...HEADLESS, '--dump-config'], { timeoutMs: 120_000 })
  expect(run.timedOut).toBe(false)
  expect(run.code).toBe(0)
  expect(run.output).toContain('id: mcp-support')
  expect(run.output).toContain('@royenheart/dsh-plugin-mcp-support')
  expect(run.output).toContain('serverName: fixture')
})

test('a stdio entry with every documented field is accepted and mounted', async () => {
  const id = 'headless-full-stdio'
  const marker = path.join(scenarioMarkers(id), 'fixture.txt')
  const home = probeHome(id, {
    servers: [stdioFixture('fixture', {
      markerFile: marker,
      toolCallTimeoutMs: 20_000,
      maxInstructionBytes: 4_096,
      reconnect: { enabled: false, initialDelayMs: 100, maxDelayMs: 1_000, maxAttempts: 2 },
    })],
  })
  const run = await runDsh(home.home, [...HEADLESS, 'e2e full stdio probe'], { timeoutMs: 150_000 })
  expect(run.timedOut).toBe(false)
  expect(run.output).not.toMatch(/invalid config/)
  const lines = await waitForMarkerLine(marker, /^method tools\/list$/, 30_000)
  expect(lines).toContain('method initialize')
  assertCliTripwire(run.output)
})

test('a dead server with the default failOnStartupError:false does not fail activation', async () => {
  const id = 'headless-dead-tolerated'
  const marker = path.join(scenarioMarkers(id), 'fixture.txt')
  const home = probeHome(id, {
    servers: [
      deadStdioFixture('dead', { failOnStartupError: false }),
      stdioFixture('fixture', { markerFile: marker }),
    ],
  })
  const run = await runDsh(home.home, [...HEADLESS, 'e2e tolerated failure probe'], { timeoutMs: 150_000 })
  expect(run.timedOut, `headless boot timed out:\n${run.output}`).toBe(false)
  // The row activates and the healthy sibling still mounts: the default is
  // "stay mounted and keep retrying", not "reject activation".
  expect(run.output).not.toMatch(/failed to apply loader entry mcp-support/)
  expect(run.output).toMatch(/MISSING_CREDENTIAL/)
  const lines = await waitForMarkerLine(marker, /^method tools\/list$/, 30_000)
  expect(lines).toContain('ready')
  assertCliTripwire(run.output)
})

test('an invalid serverName fails the boot with the schema union error', async () => {
  const home = probeHome('headless-invalid-name', {
    servers: [{ transport: 'stdio', serverName: 'bad name!', command: process.execPath, args: [], failOnStartupError: false }],
  })
  const run = await runDsh(home.home, [...HEADLESS, 'e2e invalid probe'], { timeoutMs: 120_000 })
  expect(run.timedOut).toBe(false)
  expect(run.code).not.toBe(0)
  expect(run.output).toMatch(/failed to apply loader entry mcp-support/)
  expect(run.output).toMatch(/invalid config/)
  expect(run.output).toMatch(/serverName/)
  assertCliTripwire(run.output, [/invalid config/, /failed to apply loader entry mcp-support/])
})

test('a duplicate serverName in the composition list fails the boot with the documented message', async () => {
  const home = probeHome('headless-duplicate-composition', {
    servers: [deadStdioFixture('dup'), deadStdioFixture('dup')],
  })
  const run = await runDsh(home.home, [...HEADLESS, 'e2e duplicate probe'], { timeoutMs: 120_000 })
  expect(run.timedOut).toBe(false)
  expect(run.code).not.toBe(0)
  expect(run.output).toMatch(/duplicate serverName "dup"/)
  assertCliTripwire(run.output, [/duplicate serverName/])
})

test('a duplicate serverName in the persisted settings section is refused at the settings seam', async () => {
  const home = probeHome('headless-duplicate-settings', {
    servers: [],
    settings: {
      'mcp-support': {
        servers: [deadStdioFixture('same'), deadStdioFixture('same')],
      },
    },
  })
  const run = await runDsh(home.home, [...HEADLESS, 'e2e duplicate settings probe'], { timeoutMs: 120_000 })
  expect(run.timedOut).toBe(false)
  expect(run.code).not.toBe(0)
  // The section is refused while the namespace is registered, not stored and
  // later reconciled: the plugin never mounts a list it cannot merge.
  expect(run.output).toMatch(/duplicate serverName "same"/)
  assertCliTripwire(run.output, [/duplicate serverName/])
})
