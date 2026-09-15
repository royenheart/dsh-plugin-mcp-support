/**
 * Paths, environment knobs, and the disposable package copy the suite installs.
 *
 * The suite never writes into the checkout under test: `install.py` rebuilds
 * `lib/` in whatever package root it is run from, so the install/dev-surface
 * specs run it against a throwaway copy materialized here. Everything else
 * (dsh homes, profiles, markers, browser state) lives under `tempRoot()`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** `<repo>/e2e`. */
export const e2eDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The plugin checkout that contains this suite (`<repo>`). */
export const checkoutRoot = path.resolve(e2eDir, '..')

/**
 * The package under test. Defaults to the checkout that owns this suite; set
 * `DSH_E2E_PACKAGE_ROOT` to point the suite at another working tree.
 */
export function packageRoot(): string {
  return path.resolve(process.env.DSH_E2E_PACKAGE_ROOT ?? checkoutRoot)
}

/** The MCP fixture servers (`e2e/fixtures`). */
export function fixturesDir(): string {
  return path.join(packageRoot(), 'e2e', 'fixtures')
}

/** The dsh launcher. Pin it: `DSH_E2E_DSH_BIN=/path/to/dsh-0.1.6-alpha.1/bin/dsh`. */
export function dshBin(): string {
  return process.env.DSH_E2E_DSH_BIN ?? 'dsh'
}

/** Root for every temporary artifact this run owns. */
export function tempRoot(): string {
  const root = process.env.DSH_E2E_TMP ?? path.join(os.tmpdir(), 'dsh-mcp-support-e2e')
  fs.mkdirSync(root, { recursive: true })
  return root
}

/** The prepared template home every scenario is cloned from. */
export function templateHome(): string {
  return process.env.DSH_E2E_TEMPLATE_HOME ?? path.join(tempRoot(), 'template')
}

/**
 * Reuse an already prepared template home unless `DSH_E2E_FRESH_TEMPLATE=1`.
 * Preparation installs the web/headless profile bundles from the registry, so
 * reuse keeps local re-runs cheap; CI starts from an empty temp root anyway.
 */
export function reuseTemplateHome(): boolean {
  return process.env.DSH_E2E_FRESH_TEMPLATE !== '1'
}

const COPY_EXCLUDES = new Set(['.git', '.dsh-migrate', 'node_modules', 'test-results', 'playwright-report'])

/**
 * Copy the package under test to a scratch directory so `install.py` and the
 * `npm run` dev commands can write `lib/` without touching the checkout.
 *
 * `node_modules` is symlinked (the copy resolves the same toolchain and
 * harness peers as the checkout); the install script skips `npm install` when
 * that link is present. Any existing `lib/` is copied too, so a scenario that
 * boots before the install/dev specs still finds a built bundle — `install.py`
 * and `npm run build` rebuild it as documented either way.
 *
 * The copy is shared by every spec and is re-created in place, which is safe
 * because the suite runs one worker with `fullyParallel: false`.
 */
export function materializePackageCopy(): string {
  const target = path.join(tempRoot(), 'package-copy')
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  const source = packageRoot()
  fs.cpSync(source, target, {
    recursive: true,
    dereference: false,
    filter: (src) => {
      const relative = path.relative(source, src)
      if (relative === '') return true
      return !relative.split(path.sep).some((segment) => COPY_EXCLUDES.has(segment))
    },
  })
  const modules = path.join(source, 'node_modules')
  if (fs.existsSync(modules)) {
    fs.symlinkSync(modules, path.join(target, 'node_modules'), 'dir')
  }
  return target
}
