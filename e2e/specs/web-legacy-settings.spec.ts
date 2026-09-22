/**
 * Persisted settings layer — legacy `settings.yaml` import, the volatile
 * re-sync it commits, and failure handling inside that committed update.
 *
 * Ledger: settings-import-legacy-yaml, volatile-update-resync,
 * committed-update-mount-failure, status-view-mounted-dot.
 *
 * Deterministic state: the composition layer (a local defaults bundle) carries
 * one live server; `$DSH_HOME/settings.yaml` carries the legacy `mcp-support`
 * section with one live server and one server whose child always exits
 * non-zero with `failOnStartupError: true`. The harness settings service
 * imports that section once, after the loader has settled, into the profile's
 * `mcp-support` override — a committed volatile update. Nothing is retried and
 * no sleep is used as a barrier: the settled status route is the observation.
 *
 * What this proves end to end:
 *   - the legacy document is renamed to `settings.yaml.imported` and its
 *     section lands in the profile patch (the settings layer);
 *   - the newly committed list re-syncs the mounted set without remounting the
 *     plugin (the status route and the browser tab stay live);
 *   - composition mounts survive the update;
 *   - a mount failure inside a committed update leaves the previous mounts in
 *     place and is reported per row (`mounted: false` + error) on a 200 route.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
import { names, row, settledStatus } from '../helpers/status.ts'
import {
  addWorkspace,
  armConsoleTripwire,
  dotStyle,
  geometryFindings,
  openHarness,
  openMcpTab,
  settledAria,
  settledText,
  settledTexts,
  startSession,
} from '../helpers/ui.ts'
import { pollStable } from '../helpers/poll.ts'

test.describe('legacy settings import and committed-update re-sync', () => {
  let home: DshHome
  let web: WebProfile
  let workspace: string

  test.beforeAll(async () => {
    home = await createDshHome('web')
    addLocalBundle(home, 'mcp-defaults', mcpSupportPatchYaml([
      stdioServerYaml('keep'),
    ]))
    // The profile layer starts empty: every settings server below arrives only
    // through the legacy import after boot.
    home.writePatch('[]\n')
    writeLegacySettings(home, [
      stdioServerYaml('imported'),
      stdioServerYaml('dead', {
        command: process.execPath,
        args: ['-e', "process.stderr.write('dead'); process.exit(3)"],
        failOnStartupError: true,
      }),
    ])
    workspace = mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-ws-'))
    web = await startWebProfile(home)
  })

  test.afterAll(async () => {
    await web?.stop()
    home?.dispose()
    if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true })
  })

  test('imports the legacy section, re-syncs mounts, and reports the failed row', async ({ page }) => {
    const tripwire = armConsoleTripwire(page)

    // The import is a host-side effect: the file is renamed before the first
    // write, and the section lands in the profile patch (the settings layer).
    await pollStable(() => existsSync(path.join(home.root, 'settings.yaml.imported')), {
      timeoutMs: 60_000,
      description: 'settings.yaml.imported to exist',
    })
    expect(existsSync(path.join(home.root, 'settings.yaml'))).toBe(false)
    await pollStable(() => readFileSync(home.patchFile, 'utf8').includes('serverName: imported'), {
      timeoutMs: 30_000,
      description: 'profile patch to receive the imported section',
    })

    // Settled host projection: composition mount survives, imported mount
    // arrives through the committed update, failed mount is reported.
    const status = await settledStatus(web, {
      until: (read) => names(read).length === 3 && read.servers.every((server) => server.mounted || server.error !== undefined),
    })
    expect(status.httpStatus).toBe(200)
    expect(names(status)).toEqual(['keep', 'imported', 'dead'])
    expect(row(status, 'keep')?.mounted).toBe(true)
    expect(row(status, 'imported')?.mounted).toBe(true)
    expect(row(status, 'dead')?.mounted).toBe(false)
    expect(row(status, 'dead')?.error ?? '').toMatch(/dead|initial connection/i)

    // Browser projection of the same three states.
    await openHarness(page, web)
    await addWorkspace(page, workspace)
    await startSession(page, 'mcp-support e2e: legacy import')
    const view = await openMcpTab(page)
    const rowNames = await settledTexts(view.locator('.mcp-status-name'), {
      accept: (texts) => texts.length === 3,
      description: 'status row names',
    })
    expect(rowNames).toEqual(['keep', 'imported', 'dead'])
    const text = await settledText(view, { accept: (value) => /initial connection|dead/i.test(value) })
    expect(text).toMatch(/initial connection|dead/i)
    const aria = await settledAria(view)
    expect(aria).toContain('dead')

    // Painted-state invariant: the failed row's dot is not the mounted dot.
    const dots = view.locator('.mcp-status-dot')
    await expect(dots).toHaveCount(3)
    await expect(dots.nth(0)).toHaveAttribute('title', 'mounted')
    await expect(dots.nth(1)).toHaveAttribute('title', 'mounted')
    await expect(dots.nth(2)).toHaveAttribute('title', 'not mounted')
    const [mountedDot, failedDot] = [await dotStyle(dots.nth(0)), await dotStyle(dots.nth(2))]
    expect(failedDot.background).not.toBe(mountedDot.background)

    expect(await geometryFindings(view)).toEqual([])
    tripwire.expectClean()
  })
})
