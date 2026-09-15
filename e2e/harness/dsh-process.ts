/**
 * Spawning and stopping dsh profiles.
 *
 * Every child runs in its own process group so that stopping a server also
 * reaps the MCP fixture processes the native bridge spawned. Model credentials
 * are scrubbed from the child environment: the suite is deliberately keyless,
 * which makes "send one turn" a deterministic way to reach a non-blank session
 * (the turn fails with MISSING_CREDENTIAL, the user message still persists).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { dshBin } from './paths'

/** Credential variables removed from every spawned dsh process. */
const SCRUBBED_ENV = ['DEEPSEEK_API_KEY', 'DSH_API_KEY', 'DEEPSEEK_BASE_URL'] as const

export interface DshEnvironmentOptions {
  /** Extra environment entries; `undefined` values are dropped. */
  env?: Record<string, string | undefined>
}

/** Build the child environment for a run against `home`. */
export function dshEnv(home: string, options: DshEnvironmentOptions = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home, NO_COLOR: '1', FORCE_COLOR: '0' }
  for (const key of SCRUBBED_ENV) delete env[key]
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

export interface DshRunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  output: string
  timedOut: boolean
}

/** Run a dsh command to completion (or timeout) and collect its output. */
export async function runDsh(
  home: string,
  args: string[],
  options: { timeoutMs?: number; env?: Record<string, string | undefined> } = {},
): Promise<DshRunResult> {
  return await runCommand(dshBin(), args, {
    cwd: home,
    env: dshEnv(home, { env: options.env }),
    timeoutMs: options.timeoutMs,
  })
}

/** Run any command to completion (or timeout) and collect its output. */
export async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; detached?: boolean } = { cwd: process.cwd() },
): Promise<DshRunResult> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const detached = options.detached ?? true
  return await new Promise<DshRunResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (detached) killGroup(child, 'SIGKILL')
      else child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, signal: null, stdout, stderr: `${stderr}${String(error)}`, output: `${stdout}${stderr}`, timedOut })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, output: `${stdout}${stderr}`, timedOut })
    })
  })
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch { /* already gone */ }
  }
}

export interface RunningDsh {
  readonly url: string
  readonly port: number
  /** Everything the process has written so far. */
  output(): string
  stop(): Promise<void>
}

/** `dsh web` prints exactly one line with the tokenized URL once it listens. */
const WEB_URL_LINE = /dsh web:\s+(http:\/\/\S+)/

/** Start `dsh web` against `home` on an OS-assigned port and wait until it answers. */
export async function startDshWeb(
  home: string,
  options: { profile?: string; timeoutMs?: number; env?: Record<string, string | undefined> } = {},
): Promise<RunningDsh> {
  const profile = options.profile ?? 'web'
  const timeoutMs = options.timeoutMs ?? Number(process.env.DSH_E2E_BOOT_TIMEOUT_MS ?? 240_000)
  const child = spawn(dshBin(), ['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: home,
    env: dshEnv(home, { env: options.env }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`dsh web did not print its URL within ${timeoutMs}ms:\n${output}`))
    }, timeoutMs)
    const poll = setInterval(() => {
      const match = WEB_URL_LINE.exec(output)
      if (match === null || match[1] === undefined) return
      clearInterval(poll)
      clearTimeout(timer)
      resolve(match[1])
    }, 100)
    child.on('error', (error) => {
      clearInterval(poll)
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (WEB_URL_LINE.test(output)) return
      clearInterval(poll)
      clearTimeout(timer)
      reject(new Error(`dsh web exited with ${String(code)} before printing a URL:\n${output}`))
    })
  })

  const parsed = new URL(url)
  await waitForHttp(url, timeoutMs)

  return {
    url: url.replace(/\/$/, ''),
    port: Number(parsed.port),
    output: () => output,
    async stop() {
      await stopProcess(child)
    },
  }
}

/** Poll the printed URL until the web app answers (the token URL redirects). */
async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no response'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5_000) })
      if (response.status > 0) return
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(200)
  }
  throw new Error(`dsh web never answered at ${url}: ${lastError}`)
}

/** Terminate a detached child and its process group, escalating to SIGKILL. */
export async function stopProcess(child: ChildProcess, graceMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
  killGroup(child, 'SIGTERM')
  const timed = await Promise.race([
    exited.then(() => true),
    sleep(graceMs).then(() => false),
  ])
  if (!timed) {
    killGroup(child, 'SIGKILL')
    await exited
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}
