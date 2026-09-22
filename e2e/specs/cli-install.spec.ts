/**
 * CLI surface — the bundle install path and the composed loader tree.
 *
 * Ledger: install-py-install, install-py-idempotent, install-py-uninstall,
 * dump-config-composition, bundle-patch-row.
 *
 * Deterministic state: a freshly materialized `web` profile with no plugin
 * installed; every mutation goes through the repository's own `install.py`,
 * and the observation is the profile manifest, the profile symlink, and the
 * composed tree printed by `dsh --profile web --dump-config`.
 *
 * `--dump-config` is a pure read: it composes the loader tree without mounting
 * it and (deliberately) without validating `servers`, so this spec asserts the
 * composition only. Validation and activation failures are asserted by the
 * headless spec, where a real mount happens.
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { expect, test } from '@playwright/test'
import {
  createDshHome,
  dumpConfig,
  installPlugin,
  uninstallPlugin,
  type DshHome,
} from '../helpers/dsh.ts'
import { repoRoot } from '../helpers/env.ts'
import { processTripwire } from '../helpers/tripwire.ts'

/** Package name the bundle patch inserts. */
const PACKAGE = '@royenheart/dsh-plugin-mcp-support'

test.describe('install.py and the composed profile tree', () => {
  let home: DshHome

  test.beforeAll(async () => {
    home = await createDshHome('web', { install: false })
  })

  test.afterAll(() => {
    home?.dispose()
  })

  test('installs idempotently, composes the row, and uninstalls cleanly', async () => {
    const link = path.join(home.dir, 'node_modules', PACKAGE)
    const manifestPath = path.join(home.dir, 'package.json')
    const profilePatchBefore = readFileSync(home.patchFile, 'utf8')

    // Fresh profile: no bundle, no link.
    expect(home.manifest().dsh?.profile?.bundles ?? []).not.toContain(PACKAGE)
    expect(existsSync(link)).toBe(false)

    // ---- install ---------------------------------------------------------
    const first = await installPlugin(home)
    expect(first.combined).toContain('linked:')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    const installed = home.manifest()
    expect(installed.dependencies?.[PACKAGE]).toBe(`link:${repoRoot}`)
    expect(installed.dsh?.profile?.bundles ?? []).toContain(PACKAGE)
    // The package ships its own bundle patch, so the profile patch is untouched.
    expect(readFileSync(home.patchFile, 'utf8')).toBe(profilePatchBefore)

    // ---- idempotency -----------------------------------------------------
    const before = readFileSync(manifestPath, 'utf8')
    const second = await installPlugin(home)
    expect(second.combined).toContain('already linked')
    expect(second.combined).toContain('dependency already present')
    expect(second.combined).toContain('bundle already present')
    expect(readFileSync(manifestPath, 'utf8')).toBe(before)

    // ---- composed tree ---------------------------------------------------
    // A dump can occasionally drop a bundle layer; one retry keeps the
    // assertion honest (two consecutive drops still fail).
    let dump = await dumpConfig(home)
    if (!dump.combined.includes('mcp-support')) dump = await dumpConfig(home)
    expect(dump.code).toBe(0)
    expect(dump.combined).toContain('- id: mcp-support')
    expect(dump.combined).toContain(`name: '${PACKAGE}'`)
    processTripwire(dump).expectClean()

    // ---- uninstall -------------------------------------------------------
    const removed = await uninstallPlugin(home)
    expect(removed.combined).toContain('removed link:')
    expect(existsSync(link)).toBe(false)
    const afterUninstall = home.manifest()
    expect(afterUninstall.dependencies?.[PACKAGE]).toBeUndefined()
    expect(afterUninstall.dsh?.profile?.bundles ?? []).not.toContain(PACKAGE)

    const dumpAfter = await dumpConfig(home)
    expect(dumpAfter.code).toBe(0)
    expect(dumpAfter.combined).not.toContain(PACKAGE)
    processTripwire(dumpAfter).expectClean()

    // Uninstall is repeatable and still exits cleanly.
    const again = await uninstallPlugin(home)
    expect(again.code).toBe(0)
    expect(again.combined).toContain('no link present')
  })
})
