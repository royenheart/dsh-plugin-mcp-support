/**
 * Web status view — tab registration, empty state, refresh, and the status
 * endpoint's HTTP contract.
 *
 * Ledger: web-status-tab, web-status-empty-state, web-status-refresh,
 * status-endpoint-get, status-endpoint-method-guard, status-endpoint-unknown-path.
 *
 * Deterministic state: a real `dsh web` profile whose `mcp-support` row has an
 * empty `servers` list, reached through a typed workspace path (the in-page
 * `browse` directory picker) and the sidebar's New Session control. No model
 * call is needed, and no wait uses `networkidle`.
 *
 * One boot per file keeps the browser flow linear: the workspace registrations
 * persist in the DSH home, so a second test in the same home would race the
 * sidebar tree instead of exercising the plugin.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { expect, test } from '@playwright/test'
import {
  createDshHome,
  startWebProfile,
  STATUS_PATH,
  type DshHome,
  type WebProfile,
} from '../helpers/dsh.ts'
import { readStatus, settledStatus } from '../helpers/status.ts'
import {
  addWorkspace,
  armConsoleTripwire,
  geometryFindings,
  openHarness,
  openMcpTab,
  settledAria,
  settledText,
  startSession,
} from '../helpers/ui.ts'

test.describe('mcp status view with no servers configured', () => {
  let home: DshHome
  let web: WebProfile
  let workspace: string

  test.beforeAll(async () => {
    home = await createDshHome('web')
    home.writePatch('[]\n')
    workspace = mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-ws-'))
    web = await startWebProfile(home)
  })

  test.afterAll(async () => {
    await web?.stop()
    home?.dispose()
    if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true })
  })

  test('the mcp tab renders the empty status page and the endpoint contract', async ({ page }) => {
    const tripwire = armConsoleTripwire(page)
    await openHarness(page, web)
    await addWorkspace(page, workspace)
    const tablist = await startSession(page, 'mcp-support e2e: empty status view')

    // The plugin's tab is addressed by its registered label, never by index.
    const mcpTab = tablist.getByRole('tab', { name: 'mcp', exact: true })
    await expect(mcpTab).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Chat' })).toBeVisible()
    const view = await openMcpTab(page)
    await expect(mcpTab).toHaveAttribute('aria-selected', 'true')

    // Heading and refresh control are the page's stable accessible frame.
    await expect(view.getByRole('heading', { name: 'MCP 状态' })).toBeVisible()
    await expect(view.getByRole('button', { name: '刷新' })).toBeVisible()

    // Empty state: two agreeing reads before asserting.
    expect(await settledText(view, { accept: (text) => !text.includes('Loading') }))
      .toContain('No MCP servers configured.')
    const aria = await settledAria(view, { accept: (snapshot) => snapshot.includes('No MCP servers configured') })
    expect(aria).toContain('MCP 状态')
    expect(aria).toContain('No MCP servers configured.')

    // Baseline-free layout invariant: nothing clipped by the view box.
    expect(await geometryFindings(view)).toEqual([])

    // Refresh commits exactly one new status request and the copy settles back.
    const refreshRequest = page.waitForRequest((request) =>
      request.url().includes('/plugins/@royenheart/dsh-plugin-mcp-support/status'))
    await view.getByRole('button', { name: '刷新' }).click()
    await refreshRequest
    expect(await settledText(view, { accept: (text) => !text.includes('Loading') }))
      .toContain('No MCP servers configured.')

    // HTTP contract of the same route.
    const get = await settledStatus(web)
    expect(get.httpStatus).toBe(200)
    expect(get.body).toEqual({ ok: true, servers: [] })

    const head = await web.request(STATUS_PATH, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')

    const post = await readStatus(web, { method: 'POST' })
    expect(post.httpStatus).toBe(405)
    expect(post.body).toEqual({ ok: false, error: 'method not allowed' })

    const missing = await web.request('/plugins/@royenheart/dsh-plugin-mcp-support/not-a-route')
    expect(missing.status).toBe(404)

    tripwire.expectClean()
  })
})
