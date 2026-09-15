/**
 * C6 — the bundle / install surface.
 *
 * Feature ledger rows: `install-script`, `bundle-wiring`.
 *
 * `install.py` rebuilds `lib/` in the package it is run from, so this spec runs
 * the copy materialized by the harness instead of dirtying the checkout under
 * test; everything else is the documented path: link into the profile
 * `node_modules`, add the `link:` dependency, append the package to
 * `dsh.profile.bundles`, and never touch the profile's own `cordis.patch.yml`.
 *
 * The final test boots the freshly installed profile and reaches the plugin's
 * tab in Chromium, so "installed" is verified as "serves the feature", not as
 * "the manifest contains a string".
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, assertCliTripwire } from '../harness/test'
import { materializeScenarioHome, runPython, type ScenarioHome } from '../harness/dsh-home'
import { materializePackageCopy } from '../harness/paths'
import { startDshWeb } from '../harness/dsh-process'
import { openApp, openMcpView, statusSnapshot } from '../harness/app'

const PACKAGE = '@royenheart/dsh-plugin-mcp-support'

let pkg: string
let home: ScenarioHome

test.beforeAll(() => {
  pkg = materializePackageCopy()
  home = materializeScenarioHome({ id: 'install-cli', servers: [], settings: null })
})

function manifest(): {
  dependencies: Record<string, string>
  dsh: { profile: { bundles: string[] } }
} {
  return JSON.parse(fs.readFileSync(path.join(home.profileDir, 'package.json'), 'utf8'))
}

function linkPath(): string {
  return path.join(home.profileDir, 'node_modules', PACKAGE)
}

test('uninstall removes the bundle, the dependency and the link, and is idempotent', async () => {
  expect(manifest().dependencies[PACKAGE], 'template install wired the dependency').toMatch(/^link:/)
  expect(manifest().dsh.profile.bundles).toContain(PACKAGE)
  expect(fs.lstatSync(linkPath()).isSymbolicLink()).toBe(true)

  const first = await runPython(pkg, ['install.py', 'uninstall', '--profile', 'web', '--home', home.home])
  expect(first.code, first.output).toBe(0)
  expect(first.output).toMatch(/removed link:/)
  expect(first.output).toMatch(/removed dependency:/)
  expect(first.output).toMatch(/removed bundle:/)
  expect(fs.existsSync(linkPath())).toBe(false)
  expect(manifest().dependencies[PACKAGE]).toBeUndefined()
  expect(manifest().dsh.profile.bundles).not.toContain(PACKAGE)

  const second = await runPython(pkg, ['install.py', 'uninstall', '--profile', 'web', '--home', home.home])
  expect(second.code, second.output).toBe(0)
  expect(second.output).toMatch(/no link present:/)
  expect(second.output).toMatch(/uninstalled from profile/)
  assertCliTripwire(`${first.output}${second.output}`)
})

test('install wires the bundle into the profile, is idempotent, and leaves the profile patch untouched', async () => {
  const patchBefore = fs.readFileSync(home.patchFile, 'utf8')

  const first = await runPython(pkg, ['install.py', 'install', '--profile', 'web', '--home', home.home], { timeoutMs: 600_000 })
  expect(first.code, first.output).toBe(0)
  expect(first.output).toMatch(/linked:/)
  expect(first.output).toMatch(/added dependency:/)
  expect(first.output).toMatch(/added bundle:/)
  expect(manifest().dependencies[PACKAGE]).toBe(`link:${pkg}`)
  expect(manifest().dsh.profile.bundles).toContain(PACKAGE)
  expect(fs.realpathSync(linkPath())).toBe(fs.realpathSync(pkg))

  const second = await runPython(pkg, ['install.py', 'install', '--profile', 'web', '--home', home.home], { timeoutMs: 600_000 })
  expect(second.code, second.output).toBe(0)
  expect(second.output).toMatch(/already linked:/)
  expect(second.output).toMatch(/dependency already present:/)
  expect(second.output).toMatch(/bundle already present:/)

  expect(fs.readFileSync(home.patchFile, 'utf8'), 'the profile patch is never modified').toBe(patchBefore)
  assertCliTripwire(`${first.output}${second.output}`)
})

test('a freshly installed profile serves the plugin status tab', async ({ page }) => {
  const server = await startDshWeb(home.home)
  try {
    await openApp(page, server.url)
    await openMcpView(page, { workspacePath: home.workspaceDir })
    const snapshot = await statusSnapshot(page, (value) => value.rows.length === 0)
    expect(snapshot.viewText).toContain('No MCP servers configured.')
    expect(snapshot.heading).toBe('MCP 状态')
  } finally {
    // Close the page before stopping the host: tearing the server down under a
    // live SSE/WebSocket client produces connection errors the tripwire would
    // (correctly) report.
    await page.goto('about:blank').catch(() => {})
    await page.close().catch(() => {})
    await server.stop()
  }
})
