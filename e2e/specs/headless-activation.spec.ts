/**
 * Headless profile — plugin activation without a web server, real child
 * mounts, and the `failOnStartupError` contract.
 *
 * Ledger: headless-activation-no-webserver, native-mcp-tool-mount,
 * fail-on-startup-error, duplicate-name-activation-error,
 * invalid-server-name-rejected.
 *
 * Deterministic state: a real `dsh headless` profile (bundles `dsh-base` +
 * `dsh-headless`; no Host, HTTP server, or Web runtime) with the plugin
 * installed, and — for the mount proof — a stdio fixture server that writes a
 * readiness marker file from inside its own process. The marker proves the
 * plugin spawned and connected the native child; it does not depend on
 * sampling `/proc` while a 1-2s boot is in flight.
 *
 * No model call is possible here (no credentials), and none is needed: the
 * run is expected to end at the credential/model failure. Activation is
 * observed as the ABSENCE of the loader's `did not activate` /
 * `pending (waiting for service: …)` diagnostics plus the presence of the
 * marker the plugin's child wrote.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { expect, test } from '@playwright/test'
import {
  createDshHome,
  mcpSupportPatchYaml,
  runHeadless,
  stdioServerYaml,
  type DshHome,
} from '../helpers/dsh.ts'
import { pollStable } from '../helpers/poll.ts'
import { processTripwire } from '../helpers/tripwire.ts'

/** The credential failure that ends a keyless headless boot. */
const MODEL_BOUNDARY = /MISSING_CREDENTIAL|AUTH:|TRANSPORT:/i

test.describe('headless activation', () => {
  let home: DshHome

  test.beforeAll(async () => {
    home = await createDshHome('headless')
  })

  test.afterAll(() => {
    home?.dispose()
  })

  test('activates and mounts a stdio server without a web server', async () => {
    const marker = path.join(mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-marker-')), 'fixture.pid')
    home.writePatch(mcpSupportPatchYaml([
      stdioServerYaml('fixture', { env: { MCP_FIXTURE_MARKER: marker } }),
    ]))
    const result = await runHeadless(home, 'say hi', { env: { DEEPSEEK_API_KEY: '' } })

    // Boot reached the credential boundary: the profile ran end to end.
    expect(result.combined).toMatch(MODEL_BOUNDARY)
    // No activation diagnostic: `webServer` is optional, so the entry is not
    // left pending in a profile that mounts no HTTP server.
    expect(result.combined).not.toMatch(/did not activate|pending \(waiting for service/i)
    // Tripwire with the credential line allowed (it is the expected boundary).
    processTripwire(result, { allow: [MODEL_BOUNDARY, /api key|credential/i] }).expectClean()

    // The plugin really spawned and connected the native child.
    await pollStable(() => existsSync(marker), { timeoutMs: 20_000, description: 'fixture readiness marker' })
    expect(Number.parseInt(readFileSync(marker, 'utf8').trim(), 10)).toBeGreaterThan(0)
  })

  test('failOnStartupError rejects activation with the server name in the message', async () => {
    home.writePatch(mcpSupportPatchYaml([
      stdioServerYaml('dead', {
        command: process.execPath,
        args: ['-e', "process.stderr.write('dead'); process.exit(3)"],
        failOnStartupError: true,
      }),
    ]))
    const result = await runHeadless(home, 'say hi', { env: { DEEPSEEK_API_KEY: '' } })

    expect(result.combined).toMatch(/did not activate/i)
    expect(result.combined).toMatch(/mcp-support/)
    expect(result.combined).toMatch(/dead|initial connection|failed/i)
    processTripwire(result, {
      allow: [/did not activate/i, /mcp-support/, /initial connection|failed/i, MODEL_BOUNDARY],
    }).expectClean()
  })

  test('duplicate serverName fails activation with a clear error', async () => {
    home.writePatch(mcpSupportPatchYaml([
      stdioServerYaml('dup', { args: ['-e', 'process.exit(0)'] }),
      stdioServerYaml('dup', { args: ['-e', 'process.exit(0)'] }),
    ]))
    const result = await runHeadless(home, 'say hi', { env: { DEEPSEEK_API_KEY: '' } })

    expect(result.combined).toMatch(/did not activate/i)
    expect(result.combined).toMatch(/duplicate serverName "dup"/)
    processTripwire(result, {
      allow: [/did not activate/i, /duplicate serverName/i, /mcp-support/, MODEL_BOUNDARY],
    }).expectClean()
  })

  test('an invalid serverName is rejected at mount time', async () => {
    home.writePatch(mcpSupportPatchYaml([
      stdioServerYaml('bad name!', { args: ['-e', 'process.exit(0)'] }),
    ]))
    const result = await runHeadless(home, 'say hi', { env: { DEEPSEEK_API_KEY: '' } })

    // `--dump-config` prints the row unvalidated; the schema rejects it when
    // the Loader mounts the entry.
    expect(result.combined).toMatch(/did not activate/i)
    expect(result.combined).toMatch(/bad name!|serverName|invalid config/i)
    processTripwire(result, {
      allow: [/did not activate/i, /bad name!|serverName|invalid config/i, /mcp-support/, MODEL_BOUNDARY],
    }).expectClean()
  })
})
