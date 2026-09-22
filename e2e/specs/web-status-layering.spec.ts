/**
 * Web status view — the two config layers.
 *
 * Ledger: composition-servers, settings-layer-override, settings-layer-append,
 * js-expression-config, stdio-server-mount, streamable-http-server,
 * status-view-server-rows, status-view-layout.
 *
 * Deterministic state: the composition layer is supplied by a local bundle
 * patch registered after the plugin bundle (a deployment that vendors default
 * servers); the persisted settings layer is the profile's own
 * `cordis.patch.yml`. `!!js` expressions appear in BOTH layers, so a schema
 * rejection or an unevaluated expression cannot hide: the entry would fail to
 * activate instead of producing rows.
 *
 * Expected effective list, in order:
 *   comp-live      composition stdio, overridden by settings to streamable-http
 *   comp-only      composition stdio, command from `!!js process.execPath`
 *   settings-only  settings-only stdio, command from `!!js process.execPath`
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
  streamableHttpServerYaml,
  type DshHome,
  type WebProfile,
} from '../helpers/dsh.ts'
import { fixturePath, repoRoot } from '../helpers/env.ts'
import { names, row, settledStatus } from '../helpers/status.ts'
import {
  addWorkspace,
  armConsoleTripwire,
  dotStyle,
  geometryFindings,
  openHarness,
  openMcpTab,
  settledAria,
  settledTexts,
  startSession,
} from '../helpers/ui.ts'

/** A stdio block whose `command` is a Loader-evaluated `!!js` expression. */
function jsStdioServerYaml(serverName: string, args: string[]): string {
  return [
    `        - transport: stdio`,
    `          serverName: ${serverName}`,
    `          command: !!js process.execPath`,
    `          args:`,
    ...args.map((arg) => `            - ${JSON.stringify(arg)}`),
    `          cwd: ${JSON.stringify(repoRoot)}`,
    `          failOnStartupError: false`,
    `          toolCallTimeoutMs: 15000`,
  ].join('\n')
}

test.describe('composition and persisted settings layers', () => {
  let home: DshHome
  let web: WebProfile
  let workspace: string

  test.beforeAll(async () => {
    home = await createDshHome('web')
    const fixture = fixturePath('fixture-mcp-server.mjs')
    // Composition layer: a vendored defaults bundle below the profile layer.
    addLocalBundle(home, 'mcp-defaults', mcpSupportPatchYaml([
      stdioServerYaml('comp-live'),
      jsStdioServerYaml('comp-only', [fixture]),
    ]))
    // Persisted settings layer: override one composition name, append another.
    home.writePatch(mcpSupportPatchYaml([
      streamableHttpServerYaml('comp-live', { url: 'http://127.0.0.1:9/mcp' }),
      jsStdioServerYaml('settings-only', [fixture]),
    ]))
    workspace = mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-ws-'))
    web = await startWebProfile(home)
  })

  test.afterAll(async () => {
    await web?.stop()
    home?.dispose()
    if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true })
  })

  test('settings override by name, append settings-only, and evaluate !!js in both layers', async ({ page }) => {
    const tripwire = armConsoleTripwire(page)

    // Host projection first: it is the authoritative effective list.
    const status = await settledStatus(web, { until: (read) => names(read).length === 3 })
    expect(status.httpStatus).toBe(200)
    expect(names(status)).toEqual(['comp-live', 'comp-only', 'settings-only'])
    expect(row(status, 'comp-live')).toEqual({
      serverName: 'comp-live',
      transport: 'streamable-http',
      mounted: true,
    })
    expect(row(status, 'comp-only')).toEqual({ serverName: 'comp-only', transport: 'stdio', mounted: true })
    expect(row(status, 'settings-only')).toEqual({ serverName: 'settings-only', transport: 'stdio', mounted: true })

    // Browser projection: same rows, same order, same labels.
    await openHarness(page, web)
    await addWorkspace(page, workspace)
    await startSession(page, 'mcp-support e2e: config layering')
    const view = await openMcpTab(page)
    const rowNames = await settledTexts(view.locator('.mcp-status-name'), {
      accept: (texts) => texts.length === 3,
      description: 'status row names',
    })
    expect(rowNames).toEqual(['comp-live', 'comp-only', 'settings-only'])
    const aria = await settledAria(view)
    for (const name of ['comp-live', 'comp-only', 'settings-only']) expect(aria).toContain(name)

    // Transport labels are user-visible text, not attributes.
    const transports = await settledTexts(view.locator('.mcp-status-transport'), { accept: (texts) => texts.length === 3 })
    expect(transports).toEqual(['streamable-http', 'stdio', 'stdio'])

    // Layout invariant and painted dot invariant (no baseline needed).
    expect(await geometryFindings(view)).toEqual([])
    const dots = view.locator('.mcp-status-dot')
    await expect(dots).toHaveCount(3)
    for (let index = 0; index < 3; index += 1) {
      const dot = dots.nth(index)
      await expect(dot).toHaveAttribute('title', 'mounted')
      const style = await dotStyle(dot)
      expect(style.visible).toBe(true)
      expect(style.width).toBeGreaterThanOrEqual(6)
      expect(style.height).toBeGreaterThanOrEqual(6)
      expect(style.background).not.toBe('rgba(0, 0, 0, 0)')
    }

    tripwire.expectClean()
  })
})
