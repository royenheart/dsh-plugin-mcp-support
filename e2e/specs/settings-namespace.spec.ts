/**
 * C2 + C3 — the persisted `mcp-support` settings namespace and live re-sync.
 *
 * Feature ledger rows: `settings-namespace`, `settings-overrides-composition`,
 * `live-resync`.
 *
 * Two scenarios run in this file:
 *
 * 1. `merge` — composition `[alpha, shared]` plus a settings section that
 *    redefines `shared` with a different transport and appends `gamma`.
 *    The rendered list proves the documented layering: composition order
 *    first, a same-name settings entry overrides in place, settings-only
 *    servers append.
 * 2. `live` — composition `[alpha]`, settings `[gamma]`. While the server is
 *    running, `settings.yaml` is rewritten and the view is refreshed. The
 *    delta/gamma fixture markers prove a child fiber was really mounted, and
 *    the disappearing row proves the disposed fiber is no longer reported.
 */
import path from 'node:path'
import { test, expect } from '../harness/test'
import { Scenario } from '../harness/scenario'
import { httpFixture, stdioFixture } from '../harness/config'
import { waitForMarker } from '../harness/mcp-fixture'
import { fetchStatus, openApp, openMcpView, refreshStatus, statusSnapshot, waitForHostServers, type StatusSnapshot } from '../harness/app'
import { tempRoot } from '../harness/paths'

/** Unreachable endpoint: the row must mount and render without a live peer. */
const UNREACHABLE = 'http://127.0.0.1:1/mcp'

/**
 * Marker locations are derived from the scenario id up front: the settings
 * document is written at module scope, before the scenario home exists.
 */
const MERGE_MARKERS = path.join(tempRoot(), 'scenarios', 'settings-merge', 'markers')
const LIVE_MARKERS = path.join(tempRoot(), 'scenarios', 'settings-live', 'markers')

const merge = new Scenario({
  id: 'settings-merge',
  servers: (context) => [
    stdioFixture('alpha', { markerFile: path.join(context.markersDir, 'alpha.txt') }),
    stdioFixture('shared', { markerFile: path.join(context.markersDir, 'shared-composition.txt') }),
  ],
  settings: {
    'mcp-support': {
      servers: [
        httpFixture('shared', { url: UNREACHABLE, reconnect: { enabled: false } }),
        stdioFixture('gamma', { markerFile: path.join(MERGE_MARKERS, 'gamma.txt') }),
      ],
    },
  },
})

const live = new Scenario({
  id: 'settings-live',
  servers: (context) => [stdioFixture('alpha', { markerFile: path.join(context.markersDir, 'alpha.txt') })],
  settings: {
    'mcp-support': {
      servers: [stdioFixture('gamma', { markerFile: path.join(LIVE_MARKERS, 'gamma.txt') })],
    },
  },
})

test.beforeAll(async () => {
  await merge.start()
  await live.start()
})

test.afterAll(async () => {
  await live.stop()
  await merge.stop()
})

/** Names/transports/mounted of the rendered rows. */
function visible(snapshot: StatusSnapshot): Array<Record<string, string | null>> {
  return snapshot.rows.map((row) => ({ name: row.name, transport: row.transport, mounted: row.mounted }))
}

test('a settings entry overrides the composition entry of the same serverName and settings-only servers append', async ({ page }) => {
  await openApp(page, merge.url)
  await openMcpView(page, { workspacePath: merge.workspacePath })

  const snapshot = await statusSnapshot(page, (value) => value.rows.length === 3)
  expect(visible(snapshot)).toEqual([
    { name: 'alpha', transport: 'stdio', mounted: 'mounted' },
    // `shared` comes from the composition list positionally but carries the
    // settings transport: the settings entry won the merge.
    { name: 'shared', transport: 'streamable-http', mounted: 'mounted' },
    // `gamma` exists only in the settings section and is appended last.
    { name: 'gamma', transport: 'stdio', mounted: 'mounted' },
  ])

  // The overridden composition server must never have been spawned.
  const compositionMarker = path.join(MERGE_MARKERS, 'shared-composition.txt')
  expect(await waitForMarker(compositionMarker, () => true, { timeoutMs: 500 })).toEqual([])

  // Authoritative cross-check.
  const payload = await fetchStatus(page)
  expect(payload.servers.map((server) => `${server.serverName}:${server.transport}`)).toEqual([
    'alpha:stdio',
    'shared:streamable-http',
    'gamma:stdio',
  ])
})

test('a live settings rewrite re-syncs the mounted set without a restart', async ({ page }) => {
  await openApp(page, live.url)
  await openMcpView(page, { workspacePath: live.workspacePath })

  const before = await statusSnapshot(page, (value) => value.rows.length === 2)
  expect(visible(before)).toEqual([
    { name: 'alpha', transport: 'stdio', mounted: 'mounted' },
    { name: 'gamma', transport: 'stdio', mounted: 'mounted' },
  ])

  // Add a settings-only server while the host is running. The view only
  // re-fetches on mount or on the refresh control, so gate on the host first
  // and then ask the UI to refresh instead of racing the settings watcher.
  const deltaMarker = path.join(LIVE_MARKERS, 'delta.txt')
  live.writeSettings([
    stdioFixture('gamma', { markerFile: path.join(LIVE_MARKERS, 'gamma.txt') }),
    stdioFixture('delta', { markerFile: deltaMarker }),
  ])
  await waitForHostServers(page, (servers) => servers.some((server) => server.serverName === 'delta'))
  await refreshStatus(page)
  const added = await statusSnapshot(
    page,
    (value) => value.rows.length === 3 && value.rows.some((row) => row.name === 'delta'),
  )
  expect(visible(added)).toEqual([
    { name: 'alpha', transport: 'stdio', mounted: 'mounted' },
    { name: 'gamma', transport: 'stdio', mounted: 'mounted' },
    { name: 'delta', transport: 'stdio', mounted: 'mounted' },
  ])
  // The new child fiber really mounted a process and discovered tools.
  const deltaLines = await waitForMarker(deltaMarker, (lines) => lines.includes('method tools/list'))
  expect(deltaLines).toContain('ready')

  // Drop the settings-only servers again.
  live.writeSettings([])
  await waitForHostServers(page, (servers) => servers.every((server) => server.serverName === 'alpha'))
  await refreshStatus(page)
  const removed = await statusSnapshot(page, (value) => value.rows.length === 1)
  expect(visible(removed)).toEqual([{ name: 'alpha', transport: 'stdio', mounted: 'mounted' }])

  const payload = await fetchStatus(page)
  expect(payload.servers.map((server) => server.serverName)).toEqual(['alpha'])
})
