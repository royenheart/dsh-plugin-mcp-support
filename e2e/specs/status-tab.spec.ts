/**
 * C4 — the `mcp` conversation-view tab, its empty state, and its refresh control.
 *
 * Feature ledger rows: `status-tab`, `status-empty-state`, `status-refresh`.
 *
 * Determinism: the scenario configures an empty server list, so the documented
 * "No MCP servers configured." state is reachable without depending on any MCP
 * server process. The view is reached through real gestures (new session →
 * workspace picker → one composer turn → tab), never by URL manipulation.
 */
import { test, expect } from '../harness/test'
import { Scenario, scenarioHooks } from '../harness/scenario'
import {
  MCP_TAB_LABEL,
  STATUS_ENDPOINT,
  boxes,
  openApp,
  openMcpView,
  openSessionView,
  overlappingPairs,
  statusSnapshot,
} from '../harness/app'
import { defined } from '../harness/defined'

const scenario = new Scenario({ id: 'status-tab', servers: [] })
scenarioHooks(test, scenario)

test('registers an `mcp` tab in the session header view-tab row, right of the trajectory tab', async ({ page }) => {
  await openApp(page, scenario.url)
  await openSessionView(page, { workspacePath: scenario.workspacePath })

  const tabs = page.getByRole('tab')
  const labels = (await tabs.allInnerTexts()).map((label) => label.trim())
  expect(labels, 'view-tab row labels').toContain(MCP_TAB_LABEL)

  const trajectoryIndex = labels.findIndex((label) => /^trajectory$/i.test(label) || label === '轨迹')
  expect(trajectoryIndex, 'trajectory tab is registered by the web profile').toBeGreaterThanOrEqual(0)
  expect(labels.indexOf(MCP_TAB_LABEL), 'mcp sits immediately right of trajectory').toBe(trajectoryIndex + 1)

  // Geometry invariant: one row, ordered left-to-right, nothing overlapping,
  // nothing outside the viewport — the tab row must not be clipped.
  const viewport = page.viewportSize()
  expect(viewport).not.toBeNull()
  const tabBoxes = await boxes(tabs)
  const mcpBox = defined(tabBoxes[labels.indexOf(MCP_TAB_LABEL)], 'mcp tab box')
  const trajectoryBox = defined(tabBoxes[trajectoryIndex], 'trajectory tab box')
  expect(mcpBox.width).toBeGreaterThan(0)
  expect(mcpBox.height).toBeGreaterThan(0)
  expect(mcpBox.x).toBeGreaterThanOrEqual(trajectoryBox.x + trajectoryBox.width - 1)
  for (const box of tabBoxes) {
    expect(Math.abs(box.y - trajectoryBox.y)).toBeLessThanOrEqual(2)
    expect(box.x).toBeGreaterThanOrEqual(-1)
    expect(box.x + box.width).toBeLessThanOrEqual((viewport?.width ?? 0) + 1)
  }
  expect(overlappingPairs(tabBoxes), 'view tabs must not overlap').toEqual([])

  await page.getByRole('tab', { name: MCP_TAB_LABEL, exact: true }).click()
  await expect(page.getByRole('heading', { name: 'MCP 状态' })).toBeVisible()
})

test('an empty server list renders the documented empty state', async ({ page }) => {
  await openApp(page, scenario.url)
  await openMcpView(page, { workspacePath: scenario.workspacePath })

  const snapshot = await statusSnapshot(
    page,
    (value) => value.rows.length === 0 && value.viewText.includes('No MCP servers configured.'),
  )
  expect(snapshot.heading, 'status page heading').toBe('MCP 状态')
  expect(snapshot.refreshLabel, 'refresh control label').toBe('刷新')
  expect(snapshot.rows).toEqual([])

  // Geometry invariant: the page never overflows its own box horizontally.
  const overflow = await page.locator('.mcp-status-view').first().evaluate((element) => ({
    horizontal: element.scrollWidth - element.clientWidth,
    vertical: element.scrollHeight - element.clientHeight,
  }))
  expect(overflow.horizontal).toBeLessThanOrEqual(1)
  expect(overflow.vertical).toBeLessThanOrEqual(1)
})

test('the refresh control re-fetches the status endpoint', async ({ page }) => {
  await openApp(page, scenario.url)
  await openMcpView(page, { workspacePath: scenario.workspacePath })

  const refetched = page.waitForResponse(
    (response) => response.url().includes(STATUS_ENDPOINT) && response.request().method() === 'GET' && response.status() === 200,
    { timeout: 30_000 },
  )
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await refetched

  const snapshot = await statusSnapshot(page, (value) => value.rows.length === 0)
  expect(snapshot.viewText).toContain('No MCP servers configured.')
})
