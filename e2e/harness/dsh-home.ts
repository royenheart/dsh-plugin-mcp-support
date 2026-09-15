/**
 * dsh home preparation.
 *
 * `ensureTemplateHome()` boots a throwaway home once per test run so the
 * shipped `web` profile (and its shared `profiles/node_modules`) exists, then
 * installs the plugin under test into the `web` and `headless` profiles with
 * the package's own `install.py`.
 *
 * Each scenario then clones that template into its own home: profiles are
 * copied (symlinks preserved) and `profiles/node_modules` is shared by
 * symlink, so a scenario home costs milliseconds instead of a fresh registry
 * install. Each home gets its own `settings.yaml`, which is what makes the
 * persisted-settings scenarios independent.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { compositionPatch, settingsDocument, writeYamlDocument } from './config'
import { runDsh, startDshWeb } from './dsh-process'
import { materializePackageCopy, packageRoot, reuseTemplateHome, tempRoot, templateHome } from './paths'

const TEMPLATE_MARKER = '.e2e-template.json'
const SCENARIO_PROFILES = ['web', 'headless'] as const

export interface TemplateState {
  preparedAt: string
  pluginRoot: string
  dshBin: string
  profiles: string[]
}

function templateMarkerPath(home: string): string {
  return path.join(home, TEMPLATE_MARKER)
}

function readTemplateState(home: string): TemplateState | null {
  try {
    return JSON.parse(fs.readFileSync(templateMarkerPath(home), 'utf8')) as TemplateState
  } catch {
    return null
  }
}

/**
 * Prepare (or reuse) the template home. Boots the web profile once to
 * materialize it, materializes the headless profile with `--dump-config`, and
 * installs the plugin into both.
 */
export async function ensureTemplateHome(): Promise<string> {
  const home = templateHome()
  const existing = readTemplateState(home)
  if (existing !== null && reuseTemplateHome()) {
    return home
  }

  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })

  // 1. First web boot initializes the profile and its shared module tree.
  const server = await startDshWeb(home)
  await server.stop()

  // 2. `--dump-config` materializes a shipped profile without any model call.
  for (const profile of SCENARIO_PROFILES) {
    if (profile === 'web') continue
    const dump = await runDsh(home, ['--profile', profile, '--dump-config'], { timeoutMs: 120_000 })
    if (dump.code !== 0) {
      throw new Error(`could not materialize the ${profile} profile:\n${dump.output}`)
    }
  }

  // 3. Install the package under test into every scenario profile.
  const pkg = materializePackageCopy()
  for (const profile of SCENARIO_PROFILES) {
    const result = await runPython(pkg, ['install.py', 'install', '--profile', profile, '--home', home])
    if (result.code !== 0) {
      throw new Error(`install.py install --profile ${profile} failed:\n${result.output}`)
    }
  }

  const state: TemplateState = {
    preparedAt: new Date().toISOString(),
    pluginRoot: packageRoot(),
    dshBin: process.env.DSH_E2E_DSH_BIN ?? 'dsh',
    profiles: [...SCENARIO_PROFILES],
  }
  fs.writeFileSync(templateMarkerPath(home), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  return home
}

/** Run the package's Python installer (`install.py` or any python script). */
export function runPython(
  cwd: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  const timeoutMs = options.timeoutMs ?? 300_000
  return new Promise((resolve) => {
    const child = spawn(process.env.DSH_E2E_PYTHON ?? 'python3', args, {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, output: `${output}${String(error)}`, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output, timedOut })
    })
  })
}

export interface ScenarioHomeOptions {
  /** Stable kebab-case scenario id; also the home directory name. */
  id: string
  /** Profile to clone from the template. */
  profile?: string
  /** Composition-time server list, or `null` to leave the row without config. */
  servers?: unknown[] | null
  /** Persisted `$DSH_HOME/settings.yaml` document (defaults to an empty document). */
  settings?: Record<string, unknown> | null
  /** Additional patch rows appended after the `mcp-support` row. */
  extraPatch?: unknown[]
  /** Extra files written relative to the home after cloning. */
  files?: Record<string, string>
}

export interface ScenarioHome {
  id: string
  home: string
  profile: string
  profileDir: string
  settingsFile: string
  patchFile: string
  workspaceDir: string
  markersDir: string
  /** Rewrite the composition patch (used by live-sync scenarios). */
  writeComposition(servers: unknown[] | null, extraPatch?: unknown[]): void
  /** Rewrite `settings.yaml`. */
  writeSettings(servers: unknown[] | null): void
}

/** Create a fresh scenario home cloned from the template. */
export function materializeScenarioHome(options: ScenarioHomeOptions): ScenarioHome {
  const template = templateHome()
  if (readTemplateState(template) === null) {
    throw new Error(`template home is not prepared: ${template} (global setup must run first)`)
  }
  const profile = options.profile ?? 'web'
  const home = path.join(tempRoot(), 'scenarios', options.id)
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })

  const sharedModules = path.join(template, 'profiles', 'node_modules')
  if (fs.existsSync(sharedModules)) {
    fs.symlinkSync(sharedModules, path.join(home, 'profiles', 'node_modules'), 'dir')
  }
  const sourceProfile = path.join(template, 'profiles', profile)
  if (!fs.existsSync(sourceProfile)) {
    throw new Error(`template profile is missing: ${sourceProfile}`)
  }
  fs.cpSync(sourceProfile, path.join(home, 'profiles', profile), { recursive: true, dereference: false })

  const anonymousId = path.join(template, '.anonymous-user-id')
  if (fs.existsSync(anonymousId)) fs.copyFileSync(anonymousId, path.join(home, '.anonymous-user-id'))

  const workspaceDir = path.join(home, 'workspace')
  const markersDir = path.join(home, 'markers')
  fs.mkdirSync(workspaceDir, { recursive: true })
  fs.mkdirSync(markersDir, { recursive: true })

  const scenario: ScenarioHome = {
    id: options.id,
    home,
    profile,
    profileDir: path.join(home, 'profiles', profile),
    settingsFile: path.join(home, 'settings.yaml'),
    patchFile: path.join(home, 'profiles', profile, 'cordis.patch.yml'),
    workspaceDir,
    markersDir,
    writeComposition(servers, extraPatch = []) {
      writeYamlDocument(scenario.patchFile, [...compositionPatch(servers), ...extraPatch], 'e2e scenario composition')
    },
    writeSettings(servers) {
      const doc = servers === null ? {} : settingsDocument(servers)
      writeYamlDocument(scenario.settingsFile, doc, 'e2e scenario settings')
    },
  }

  scenario.writeComposition(options.servers === undefined ? null : options.servers, options.extraPatch ?? [])
  if (options.settings === undefined || options.settings === null) scenario.writeSettings(null)
  else fs.writeFileSync(scenario.settingsFile, `# e2e scenario settings\n${JSON.stringify(options.settings, null, 2)}\n`, 'utf8')

  for (const [relative, content] of Object.entries(options.files ?? {})) {
    const file = path.join(home, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content, 'utf8')
  }
  return scenario
}
