/**
 * C1 + C3 + C7 (transport surfacing) — the effective server list as a user sees it.
 *
 * Feature ledger rows: `composition-server-list`, `stdio-transport`,
 * `streamable-http-transport`, `mounted-state`.
 *
 * The scenario configures one composition list with a real stdio fixture, a
 * real streamable-http fixture, and a second stdio fixture. The fixtures append
 * lifecycle lines to marker files, so the assertions distinguish "the row is
 * rendered" from "the native bridge actually spawned/connected and discovered
 * tools" — the view alone cannot prove the latter.
 *
 * No browser or host baseline is needed: names, transports and mounted state
 * are text/title reads plus geometry invariants.
 */
import { test, expect } from '../harness/test'
import { Scenario, scenarioHooks } from '../harness/scenario'
import { httpFixture, stdioFixture } from '../harness/config'
import { startHttpFixture, waitForMarkerLine, type HttpFixtureHandle } from '../harness/mcp-fixture'
import { boxes, fetchStatus, openApp, openMcpView, overlappingPairs, statusSnapshot } from '../harness/app'
import { defined } from '../harness/defined'
import type { ScenarioHome } from '../harness/dsh-home'

let http: HttpFixtureHandle | null = null

const scenario = new Scenario({
  id: 'composition-servers',
  // The streamable-http fixture is harness-owned (there is no child process for
  // dsh to spawn), so it starts before the composition that references it is
  // written.
  beforeBoot: async (home: ScenarioHome) => {
    http = await startHttpFixture({ markerFile: `${home.markersDir}/http.txt` })
  },
  servers: (context) => [
    stdioFixture('alpha', { markerFile: `${context.markersDir}/alpha.txt` }),
    httpFixture('remote', { url: (http as HttpFixtureHandle).url, headers: { authorization: 'Bearer e2e-fixture-token' } }),
    stdioFixture('beta', {
      markerFile: `${context.markersDir}/beta.txt`,
      toolCallTimeoutMs: 15_000,
      reconnect: { enabled: false },
    }),
  ],
})
scenarioHooks(test, scenario)

test.afterAll(async () => {
  await http?.stop()
})

test('lists every composition server in configured order with its transport and mounted state', async ({ page }) => {
  await openApp(page, scenario.url)
  await openMcpView(page, { workspacePath: scenario.workspacePath })

  const snapshot = await statusSnapshot(page, (value) => value.rows.length === 3)
  expect(snapshot.rows.map((row) => row.name)).toEqual(['alpha', 'remote', 'beta'])
  expect(snapshot.rows.map((row) => row.transport)).toEqual(['stdio', 'streamable-http', 'stdio'])
  expect(snapshot.rows.map((row) => row.mounted)).toEqual(['mounted', 'mounted', 'mounted'])
  for (const row of snapshot.rows) expect(row.error).toBeNull()

  // Geometry invariants: rows stack without overlapping, stay inside the view,
  // and short names are not truncated by their own box.
  const viewBox = defined((await boxes(page.locator('.mcp-status-view').first()))[0], 'status view box')
  const rowBoxes = await boxes(page.locator('.mcp-status-row'))
  expect(overlappingPairs(rowBoxes), 'status rows must not overlap').toEqual([])
  for (const [index, box] of rowBoxes.entries()) {
    expect(box.x).toBeGreaterThanOrEqual(viewBox.x - 1)
    expect(box.x + box.width).toBeLessThanOrEqual(viewBox.x + viewBox.width + 1)
    if (index > 0) {
      const previous = defined(rowBoxes[index - 1], 'previous row box')
      expect(box.y).toBeGreaterThanOrEqual(previous.y + previous.height - 1)
    }
  }
  const clipped = await page.locator('.mcp-status-name').evaluateAll((elements) => elements
    .map((element) => ({ text: element.textContent, clipped: element.scrollWidth - element.clientWidth }))
    .filter((entry) => entry.clipped > 1))
  expect(clipped, 'short server names must not be ellipsized').toEqual([])

  // Cross-check the visible list against the authoritative route payload.
  const payload = await fetchStatus(page)
  expect(payload.ok).toBe(true)
  expect(payload.servers.map((server) => ({
    serverName: server.serverName,
    transport: server.transport,
    mounted: server.mounted,
  }))).toEqual([
    { serverName: 'alpha', transport: 'stdio', mounted: true },
    { serverName: 'remote', transport: 'streamable-http', mounted: true },
    { serverName: 'beta', transport: 'stdio', mounted: true },
  ])
})

test('the native bridge spawns each stdio server and completes tool discovery', async () => {
  const alpha = await waitForMarkerLine(scenario.marker('alpha.txt'), /^method tools\/list$/, 30_000)
  const beta = await waitForMarkerLine(scenario.marker('beta.txt'), /^method tools\/list$/, 30_000)
  for (const [name, lines] of [['alpha', alpha], ['beta', beta]] as const) {
    expect(lines[0], `${name} fixture started`).toBe('ready')
    expect(lines).toContain('method initialize')
    expect(lines).toContain('method notifications/initialized')
  }
})

test('the streamable-http server completes the HTTP handshake and tool discovery', async () => {
  const lines = await waitForMarkerLine(scenario.marker('http.txt'), /^method tools\/list$/, 30_000)
  expect(lines.some((line) => line.startsWith('listening ')), 'fixture listened').toBe(true)
  expect(lines).toContain('method initialize')
  expect(lines).toContain('method tools/list')
})
