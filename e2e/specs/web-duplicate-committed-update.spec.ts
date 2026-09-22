/**
 * Web status view — a duplicate that arrives through a committed update.
 *
 * Ledger: committed-update-duplicate-name.
 *
 * Deterministic state: the composition layer (a local defaults bundle) holds
 * one live server, so the plugin activates and mounts; the legacy settings
 * import then commits a settings list that repeats one `serverName`. The
 * wrapper rejects the duplicate, keeps the previous mounts, and the status
 * route reports the failure as `500 {ok:false,error}` — which the browser view
 * renders as its error state. Both observations are polled to a settled value;
 * the plugin entry itself must stay active (the tab and route keep answering).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { expect, test } from '@playwright/test'
import {
  addLocalBundle,
  createDshHome,
  mcpSupportPatchYaml,
  startWebProfile,
  stdioServerYaml,
  writeLegacySettings,
  type DshHome,
  type WebProfile,
} from '../helpers/dsh.ts'
import { readStatus } from '../helpers/status.ts'
import { pollStable, waitFor } from '../helpers/poll.ts'
import {
  addWorkspace,
  armConsoleTripwire,
  openHarness,
  openMcpTab,
  settledAria,
  settledText,
  startSession,
} from '../helpers/ui.ts'

test.describe('duplicate serverName committed after boot', () => {
  let home: DshHome
  let web: WebProfile
  let workspace: string

  test.beforeAll(async () => {
    home = await createDshHome('web')
    addLocalBundle(home, 'mcp-defaults', mcpSupportPatchYaml([
      stdioServerYaml('keep'),
    ]))
    home.writePatch('[]\n')
    writeLegacySettings(home, [
      stdioServerYaml('dup', { args: ['-e', 'process.exit(0)'] }),
      stdioServerYaml('dup', { args: ['-e', 'process.exit(0)'] }),
    ])
    workspace = mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-ws-'))
    web = await startWebProfile(home)
  })

  test.afterAll(async () => {
    await web?.stop()
    home?.dispose()
    if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true })
  })

  test('reports the duplicate on the status route and in the view', async ({ page }) => {
    // The route under test answers 500 by design; the browser reports that
    // expected non-2xx fetch as a console error, so it is explicitly allowed.
    const tripwire = armConsoleTripwire(page, { allowErrors: [/status of 500/] })

    // The committed update is rejected: the route answers 500 with the clear
    // duplicate error, and stays there (two agreeing reads).
    const failed = await waitFor(
      () => readStatus(web),
      (read) => read.httpStatus === 500,
      { timeoutMs: 60_000, description: 'status route to report the duplicate' },
    )
    expect(failed.error ?? '').toMatch(/duplicate serverName "dup"/)
    const settled = await pollStable(() => readStatus(web).then((read) => read.httpStatus), {
      timeoutMs: 15_000,
      description: 'settled 500 status',
    })
    expect(settled).toBe(500)

    // The plugin entry stayed active: its tab renders and its view shows the
    // error state instead of an empty or stale list.
    await openHarness(page, web)
    await addWorkspace(page, workspace)
    await startSession(page, 'mcp-support e2e: duplicate commit')
    const view = await openMcpTab(page)
    expect(await settledText(view)).toMatch(/duplicate serverName "dup"/)
    const aria = await settledAria(view)
    expect(aria).toContain('MCP 状态')
    expect(aria).toContain('duplicate serverName')

    tripwire.expectClean()
  })
})
