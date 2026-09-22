/**
 * Real-profile driver for the mcp-support end-to-end suite.
 *
 * A spec never mocks the harness: it materializes a real DSH home, installs
 * the plugin through the shipped `install.py`, writes the profile patch a user
 * would write, and boots the real profile (`dsh web` or `dsh headless`). The
 * helpers here only make that lifecycle deterministic and leak-free.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'
import { dshBin, fixturePath, makeTempDir, profileDir, pythonBin, repoRoot } from './env.ts'
import { pollStable, waitFor } from './poll.ts'
import { run, spawnLongLived, type LongLivedProcess, type RunResult } from './process.ts'

/** One plugin entry id and settings namespace the bundle patch declares. */
export const SETTINGS_NAMESPACE = 'mcp-support'

/** Browser-facing status route registered by the plugin host half. */
export const STATUS_PATH = '/plugins/@royenheart/dsh-plugin-mcp-support/status'

/** A disposable DSH home with the plugin installed into one profile. */
export interface DshHome {
  /** Absolute DSH home root. */
  root: string
  /** Profile name the plugin is installed into. */
  profile: string
  /** Absolute profile directory. */
  dir: string
  /** Path of the profile's own cordis.patch.yml (the persisted settings layer). */
  patchFile: string
  /** Read the profile manifest (dependencies + dsh.profile.bundles). */
  manifest(): { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
  /** Overwrite the profile patch with a literal YAML document. */
  writePatch(yaml: string): void
  /** Remove the whole home. Safe to call twice. */
  dispose(): void
}

/**
 * Materialize a DSH home and its profile, then install the plugin bundle.
 *
 * @param profile - profile name to create (e.g. `web`, `headless`).
 * @param options.install - run `install.py install` after the profile exists (default true).
 * @returns the disposable home handle.
 */
export async function createDshHome(profile: string, options: { install?: boolean } = {}): Promise<DshHome> {
  const bin = dshBin()
  if (bin === undefined) throw new Error('no dsh executable found; set DSH_E2E_BIN')
  const root = makeTempDir(`dsh-e2e-${profile}-`)
  const dir = profileDir(root, profile)
  // `dsh <profile> --help` materializes the shipped profile template without
  // binding a server or reaching a model.
  const materialize = await run(bin, ['--profile', profile, '--help'], {
    env: { ...process.env, DSH_HOME: root },
    timeoutMs: 120_000,
  })
  if (!existsSync(path.join(dir, 'package.json'))) {
    throw new Error(
      `dsh did not materialize profile "${profile}" in ${root}\n`
      + `exit=${materialize.code}\n${materialize.combined}`,
    )
  }
  const home: DshHome = {
    root,
    profile,
    dir,
    patchFile: path.join(dir, 'cordis.patch.yml'),
    manifest() {
      return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as ReturnType<DshHome['manifest']>
    },
    writePatch(yaml: string) {
      writeFileSync(this.patchFile, yaml, 'utf8')
    },
    dispose() {
      rmSync(root, { recursive: true, force: true })
    },
  }
  if (options.install !== false) await installPlugin(home)
  return home
}

/**
 * Install the checkout's bundle into a home profile through the shipped script.
 * @param home - home whose profile receives the plugin.
 * @returns the install run, for callers that assert on its output.
 */
export async function installPlugin(home: DshHome): Promise<RunResult> {
  const result = await run(pythonBin(), ['install.py', 'install', '--profile', home.profile, '--home', home.root], {
    cwd: repoRoot,
    timeoutMs: 600_000,
  })
  if (result.code !== 0) {
    throw new Error(`install.py install failed (exit ${result.code})\n${result.combined}`)
  }
  return result
}

/**
 * Remove the plugin from a home profile through the shipped script.
 * @param home - home whose profile loses the plugin.
 * @returns the uninstall run, for callers that assert on its output.
 */
export async function uninstallPlugin(home: DshHome): Promise<RunResult> {
  const result = await run(pythonBin(), ['install.py', 'uninstall', '--profile', home.profile, '--home', home.root], {
    cwd: repoRoot,
    timeoutMs: 120_000,
  })
  if (result.code !== 0) {
    throw new Error(`install.py uninstall failed (exit ${result.code})\n${result.combined}`)
  }
  return result
}

/**
 * One stdio MCP server entry for a profile patch, as a YAML fragment.
 * @param serverName - unique `[A-Za-z0-9_-]{1,32}` name.
 * @param options.command - executable (default: the current node).
 * @param options.args - argv (default: the checkout's fixture MCP server).
 * @param options.failOnStartupError - whether activation must fail when the child cannot connect.
 * @returns YAML lines indented for a `servers:` list item.
 */
export function stdioServerYaml(
  serverName: string,
  options: { command?: string; args?: string[]; env?: Record<string, string>; failOnStartupError?: boolean } = {},
): string {
  const command = options.command ?? process.execPath
  const args = options.args ?? [fixturePath('fixture-mcp-server.mjs')]
  const lines = [
    `        - transport: stdio`,
    `          serverName: ${serverName}`,
    `          command: ${JSON.stringify(command)}`,
    `          args:`,
    ...args.map((arg) => `            - ${JSON.stringify(arg)}`),
    `          cwd: ${JSON.stringify(repoRoot)}`,
  ]
  const env = options.env ?? {}
  if (Object.keys(env).length > 0) {
    lines.push('          env:')
    for (const [key, value] of Object.entries(env)) lines.push(`            ${key}: ${JSON.stringify(value)}`)
  }
  lines.push(
    `          failOnStartupError: ${options.failOnStartupError === true}`,
    `          toolCallTimeoutMs: 15000`,
  )
  return lines.join('\n')
}

/**
 * One Streamable HTTP MCP server entry for a profile patch, as YAML lines.
 * @param serverName - unique name; overrides a composition entry with the same name.
 * @param options.url - MCP endpoint URL.
 * @param options.failOnStartupError - reject activation on initial connection failure (default false).
 * @returns YAML lines indented for a `servers:` list item.
 */
export function streamableHttpServerYaml(
  serverName: string,
  options: { url: string; failOnStartupError?: boolean },
): string {
  return [
    `        - transport: streamable-http`,
    `          serverName: ${serverName}`,
    `          url: ${JSON.stringify(options.url)}`,
    `          failOnStartupError: ${options.failOnStartupError === true}`,
    `          toolCallTimeoutMs: 5000`,
  ].join('\n')
}

/**
 * Wrap server YAML blocks into a loader patch row for the `mcp-support` entry.
 *
 * The identical document is valid as the profile's own `cordis.patch.yml`
 * (persisted settings layer) and as a bundle patch (composition layer).
 * @param blocks - one YAML block per server, from the `*ServerYaml` helpers.
 * @returns a complete YAML document ending in a newline.
 */
export function mcpSupportPatchYaml(blocks: string[]): string {
  return [
    `- id: ${SETTINGS_NAMESPACE}`,
    '  config:',
    '    servers:',
    ...blocks,
    '',
  ].join('\n')
}

/**
 * Add a local bundle layer to a home profile and register it after every
 * installed bundle, so its `mcp-support` row config is the composition layer.
 *
 * This mirrors a deployment that vendors a defaults overlay; it is the only
 * user-reachable way to supply the composition list on a stock profile.
 * @param home - home whose profile gains the bundle.
 * @param name - local package name (resolved from the profile's node_modules).
 * @param patchYaml - the bundle's patch document.
 * @returns the bundle directory.
 */
export function addLocalBundle(home: DshHome, name: string, patchYaml: string): string {
  const dir = path.join(home.dir, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({
    name,
    version: '0.0.0',
    private: true,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2)}\n`, 'utf8')
  writeFileSync(path.join(dir, 'cordis.patch.yml'), patchYaml, 'utf8')
  const manifestPath = path.join(home.dir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dsh?: { profile?: { bundles?: string[] } }
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes(name)) bundles.push(name)
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return dir
}

/**
 * Write the legacy `$DSH_HOME/settings.yaml` document the harness settings
 * service imports once into the profile's `mcp-support` entry override.
 * @param home - home that receives the file.
 * @param serverYamlBlocks - server blocks indented for the nested section.
 */
export function writeLegacySettings(home: DshHome, serverYamlBlocks: string[]): void {
  // A block produced for a `config.servers` patch sits two levels deeper than
  // the same list under a top-level `mcp-support:` section, so every line
  // loses exactly two leading spaces.
  const document = [
    `${SETTINGS_NAMESPACE}:`,
    '  servers:',
    ...serverYamlBlocks.flatMap((block) => block.split('\n').map((line) => line.replace(/^ {2}/u, ''))),
    '',
  ].join('\n')
  writeFileSync(path.join(home.root, 'settings.yaml'), document, 'utf8')
}

/** A running `dsh web` profile with its parsed launch URL and captured logs. */
export interface WebProfile {
  /** Origin without the token (e.g. `http://127.0.0.1:4599`). */
  origin: string
  /** Full URL including the `?token=` the CLI printed. */
  url: string
  /** Captured stdout+stderr so far. */
  logs(): string
  /** Raw fetch against the profile's web server. */
  request(pathname: string, init?: RequestInit): Promise<Response>
  /** Stop the server and release the port. */
  stop(): Promise<void>
}

/**
 * Boot `dsh web` for a home profile on a free loopback port.
 *
 * Deterministic readiness: the CLI's own launch line supplies the token, then
 * the origin must answer `/` twice in a row before the handle is returned.
 * @param home - home whose profile boots.
 * @param options.timeoutMs - boot budget (default 90s).
 * @returns the running server handle.
 */
export async function startWebProfile(home: DshHome, options: { timeoutMs?: number } = {}): Promise<WebProfile> {
  const bin = dshBin()
  if (bin === undefined) throw new Error('no dsh executable found; set DSH_E2E_BIN')
  const port = await freePort()
  const child: LongLivedProcess = spawnLongLived(bin, ['web', '--no-open', '--port', String(port)], {
    cwd: home.root,
    env: { ...process.env, DSH_HOME: home.root },
  })
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    await child.stop()
  }
  try {
    const launch = await waitFor(
      () => /dsh web: (http:\/\/\S+)/.exec(child.stdout()),
      (match) => match !== null,
      { timeoutMs: options.timeoutMs ?? 90_000, intervalMs: 100, description: 'dsh web launch URL' },
    )
    const url = launch![1]!
    const parsed = new URL(url)
    const origin = parsed.origin
    await pollStable(
      async () => {
        const response = await fetch(origin + '/')
        return response.status
      },
      { timeoutMs: 30_000, intervalMs: 250, description: 'web origin readiness' },
    )
    return {
      origin,
      url,
      logs: () => child.output(),
      request: (pathname, init) => fetch(new URL(pathname, origin), init),
      stop,
    }
  } catch (error) {
    const logs = child.output()
    await stop()
    throw new Error(`${String(error)}\n--- dsh web output ---\n${logs}`)
  }
}

/**
 * Run one headless task against a home profile.
 *
 * A model call is impossible in CI (no credentials), so the run is expected to
 * end at the transport failure; the boot itself — plugin activation and child
 * mounts — happens before it. Bounded and never retried.
 * @param home - home whose profile boots.
 * @param task - task text handed to the headless app.
 * @param options.timeoutMs - run budget (default 90s).
 * @param options.env - extra environment for the child.
 * @returns the full run result.
 */
export async function runHeadless(
  home: DshHome,
  task: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  const bin = dshBin()
  if (bin === undefined) throw new Error('no dsh executable found; set DSH_E2E_BIN')
  return await run(bin, ['headless', task], {
    cwd: home.root,
    env: { ...process.env, DSH_HOME: home.root, ...options.env },
    timeoutMs: options.timeoutMs ?? 90_000,
  })
}

/**
 * Compose a profile's loader tree without mounting it.
 * @param home - home whose profile is dumped.
 * @returns the dump run (`--dump-config`).
 */
export async function dumpConfig(home: DshHome): Promise<RunResult> {
  const bin = dshBin()
  if (bin === undefined) throw new Error('no dsh executable found; set DSH_E2E_BIN')
  return await run(bin, ['--profile', home.profile, '--dump-config'], {
    cwd: home.root,
    env: { ...process.env, DSH_HOME: home.root },
    timeoutMs: 60_000,
  })
}

/** Ask the OS for a free loopback port. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('could not allocate a loopback port'))
        return
      }
      const { port } = address
      server.close(() => { resolve(port) })
    })
  })
}
