/**
 * C8 — the local dev surface.
 *
 * Feature ledger row: `dev-surface`.
 *
 * No browser surface exists in this spec, so the console/pageerror tripwire is
 * replaced by `assertCliTripwire` on every command output.
 *
 * The commands run against the harness's disposable package copy for the same
 * reason the install spec does: `npm run build` writes `lib/`, and the suite
 * must not mutate the checkout under test. The copy carries the same sources,
 * the same `tsdown.config.ts`, and a symlink to the checkout's toolchain.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, assertCliTripwire } from '../harness/test'
import { runCommand } from '../harness/dsh-process'
import { materializePackageCopy, tempRoot } from '../harness/paths'

let pkg: string

test.beforeAll(() => {
  pkg = materializePackageCopy()
})

function npm(args: string[], timeoutMs = 900_000) {
  return runCommand('npm', args, {
    cwd: pkg,
    env: { ...process.env, NO_COLOR: '1', npm_config_cache: path.join(tempRoot(), 'npm-cache'), npm_config_update_notifier: 'false' },
    timeoutMs,
  })
}

test('npm run typecheck passes', async () => {
  const run = await npm(['run', 'typecheck'])
  expect(run.timedOut, `typecheck timed out:\n${run.output}`).toBe(false)
  expect(run.code, run.output).toBe(0)
  assertCliTripwire(run.output)
})

test('npm run build produces the host and browser bundles', async () => {
  const run = await npm(['run', 'build'])
  expect(run.timedOut, `build timed out:\n${run.output}`).toBe(false)
  expect(run.code, run.output).toBe(0)
  expect(fs.existsSync(path.join(pkg, 'lib', 'index.js')), 'host bundle').toBe(true)
  expect(fs.existsSync(path.join(pkg, 'lib', 'client.js')), 'browser bundle').toBe(true)
  assertCliTripwire(run.output)
})

test('npm test passes', async () => {
  const run = await npm(['test'])
  expect(run.timedOut, `tests timed out:\n${run.output}`).toBe(false)
  expect(run.code, run.output).toBe(0)
  // Node's reporter prints `ℹ fail 0` on a pipe and `# fail 0` on a TTY.
  expect(run.output).toMatch(/(?:ℹ|#) fail 0/)
  expect(run.output).toMatch(/(?:ℹ|#) pass \d+/)
  assertCliTripwire(run.output)
})
