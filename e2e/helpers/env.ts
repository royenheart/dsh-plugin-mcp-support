/**
 * Environment resolution for the mcp-support end-to-end suite.
 *
 * Everything the suite needs from the outside world is resolved here so a spec
 * never hardcodes a machine path:
 *
 * - the `dsh` executable under test (`DSH_E2E_BIN`, then the migration
 *   checkout's pinned install, then `dsh` on PATH),
 * - the plugin checkout root (this file lives in `<root>/e2e/helpers/`),
 * - Playwright artifact locations (gitignored).
 */
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Plugin repository root: the directory that owns `e2e/` (no trailing separator). */
export const repoRoot = fileURLToPath(new URL('../../', import.meta.url)).replace(/[/\\]$/u, '')

/** Harness version this suite is written against. */
export const TARGET_DSH_VERSION = '0.1.7-alpha.1'

/** Harness display name used in the coverage ledger. */
export const TARGET_DSH = `dsh-v${TARGET_DSH_VERSION}`

/** Writable artifact root (`DSH_E2E_ARTIFACTS`, default `<root>/.e2e-artifacts`). */
export function artifactsDir(): string {
  const dir = process.env.DSH_E2E_ARTIFACTS ?? path.join(repoRoot, '.e2e-artifacts')
  mkdirSync(dir, { recursive: true })
  return dir
}
/**
 * Candidate `dsh` executables, most specific first.
 *
 * The migration checkout keeps the pinned harness install under
 * `.dsh-migrate/dsh/<version>/bin/dsh`; a plugin branch that carries the suite
 * should set `DSH_E2E_BIN` (or have `dsh` on PATH).
 * @returns absolute candidate paths that exist.
 */
export function dshCandidates(): string[] {
  const candidates = [
    process.env.DSH_E2E_BIN,
    path.join(repoRoot, '.dsh-migrate', 'dsh', `dsh-${TARGET_DSH_VERSION}`, 'bin', 'dsh'),
    '/usr/local/bin/dsh',
    '/usr/bin/dsh',
  ]
  return candidates.filter((candidate): candidate is string => typeof candidate === 'string' && existsSync(candidate))
}

/**
 * Absolute path of the `dsh` executable under test.
 * @returns the first existing candidate, or undefined when none exists.
 */
export function dshBin(): string | undefined {
  return dshCandidates()[0]
}

/** Python 3 executable used for `install.py`. */
export function pythonBin(): string {
  return process.env.DSH_E2E_PYTHON ?? 'python3'
}

/** A fresh temp directory for one DSH home. */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** Path of a profile directory inside a DSH home. */
export function profileDir(home: string, profile: string): string {
  return path.join(home, 'profiles', profile)
}

/**
 * Absolute path of one suite fixture file.
 * @param name - file name under `e2e/fixtures/`.
 * @returns the absolute path.
 */
export function fixturePath(name: string): string {
  return path.join(repoRoot, 'e2e', 'fixtures', name)
}
