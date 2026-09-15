/**
 * C4 (error state) — the last mount error of an effective server.
 *
 * Feature ledger row: `mount-error-row`.
 *
 * A mount only rejects the child fiber when `failOnStartupError` is true; with
 * the default `false` the native bridge stays mounted and retries. Because a
 * rejecting mount also rejects plugin activation, the failed server cannot be
 * in the composition at boot — the scenario boots healthy and introduces the
 * broken server through a live settings write, which is also the path a user
 * takes when they fix a command in `settings.yaml`.
 */
import path from 'node:path'
import { test, expect } from '../harness/test'
import { Scenario, scenarioHooks } from '../harness/scenario'
import { deadStdioFixture, stdioFixture } from '../harness/config'
import { fetchStatus, openApp, openMcpView, refreshStatus, statusSnapshot, waitForHostServers } from '../harness/app'
import { tempRoot } from '../harness/paths'
import { defined } from '../harness/defined'

const MARKERS = path.join(tempRoot(), 'scenarios', 'mount-error', 'markers')

function healthy(): Record<string, unknown> {
  return stdioFixture('healthy', { markerFile: path.join(MARKERS, 'healthy.txt') })
}

const scenario = new Scenario({
  id: 'mount-error',
  servers: [healthy()],
  settings: {},
})
scenarioHooks(test, scenario)

test('a failed mount renders as a not-mounted row carrying the error message', async ({ page }) => {
  await openApp(page, scenario.url)
  await openMcpView(page, { workspacePath: scenario.workspacePath })

  const healthyOnly = await statusSnapshot(page, (value) => value.rows.length === 1)
  expect(healthyOnly.rows.map((row) => row.name)).toEqual(['healthy'])

  // Introduce the broken server while the host runs. The settings watcher
  // rejects the failed mount, records the message, and keeps serving.
  scenario.writeSettings([healthy(), deadStdioFixture('dead', { failOnStartupError: true })])
  const hostServers = await waitForHostServers(page, (servers) => servers.some((server) => server.serverName === 'dead'))
  const deadHost = defined(hostServers.find((server) => server.serverName === 'dead'), 'dead server row')
  expect(deadHost.mounted).toBe(false)
  expect(deadHost.error).toMatch(/initial connection or tool synchronization failed/)

  await refreshStatus(page)
  const snapshot = await statusSnapshot(page, (value) => value.rows.length === 2)
  const healthyRow = defined(snapshot.rows[0], 'healthy row')
  const deadRow = defined(snapshot.rows[1], 'dead row')
  expect(healthyRow.name).toBe('healthy')
  expect(healthyRow.mounted).toBe('mounted')
  expect(healthyRow.error).toBeNull()
  expect(deadRow.name).toBe('dead')
  expect(deadRow.mounted).toBe('not mounted')
  expect(deadRow.error).toMatch(/initial connection or tool synchronization failed/)
  expect(snapshot.viewText).toContain(deadRow.error ?? '')

  // Geometry invariants: the error text wraps inside its row (no clipped
  // overflow) and the two rows do not overlap.
  const detailOverflow = await page.locator('.mcp-status-detail').evaluateAll((elements) => elements.map((element) => ({
    horizontal: element.scrollWidth - element.clientWidth,
    vertical: element.scrollHeight - element.clientHeight,
  })))
  expect(detailOverflow).toEqual([{ horizontal: 0, vertical: 0 }])

  // Authoritative cross-check: the visible error is the host's own value.
  const payload = await fetchStatus(page)
  expect(payload.servers).toEqual([
    { serverName: 'healthy', transport: 'stdio', mounted: true },
    { serverName: 'dead', transport: 'stdio', mounted: false, error: deadRow.error },
  ])

  // The failed row is not a transient render: a refresh reproduces it exactly.
  await refreshStatus(page)
  const afterRefresh = await statusSnapshot(page, (value) => value.rows.length === 2)
  expect(afterRefresh.rows).toEqual(snapshot.rows)
})
