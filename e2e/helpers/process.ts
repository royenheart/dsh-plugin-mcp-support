/**
 * Child-process helpers for the mcp-support end-to-end suite.
 *
 * The suite drives real `dsh` processes, so every run is bounded by a timeout,
 * captures both streams, and never leaves a child behind: `run` kills the
 * process group on timeout, and `LongLivedProcess.stop()` escalates from
 * SIGTERM to SIGKILL.
 */
import { spawn, type ChildProcess } from 'node:child_process'

/** Result of one bounded child process run. */
export interface RunResult {
  command: string
  args: string[]
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** stdout+stderr interleaved in arrival order (useful for boot logs). */
  combined: string
  durationMs: number
  /** True when the run was killed by the suite's own timeout. */
  timedOut: boolean
}

/** Options accepted by {@link run}. */
export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** Written to the child's stdin, then stdin is closed. */
  input?: string
}

/**
 * Run one child process to completion under a hard timeout.
 * @param command - executable to spawn.
 * @param args - argv passed without shell interpolation.
 * @param options - cwd, environment overlay, timeout, and optional stdin.
 * @returns the captured result; never throws for a non-zero exit.
 */
export async function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const started = Date.now()
  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    let stdout = ''
    let stderr = ''
    let combined = ''
    let timedOut = false
    const append = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      const text = chunk.toString('utf8')
      combined += text
      if (stream === 'stdout') stdout += text
      else stderr += text
    }
    child.stdout?.on('data', (chunk: Buffer) => { append(chunk, 'stdout') })
    child.stderr?.on('data', (chunk: Buffer) => { append(chunk, 'stderr') })
    child.on('error', reject)
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    if (options.input !== undefined) child.stdin?.end(options.input)
    else child.stdin?.end()
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({
        command,
        args,
        code,
        signal,
        stdout,
        stderr,
        combined,
        durationMs: Date.now() - started,
        timedOut,
      })
    })
  })
}

/** A running long-lived child (the web server) with captured output. */
export interface LongLivedProcess {
  child: ChildProcess
  stdout(): string
  stderr(): string
  output(): string
  stop(): Promise<void>
}

/**
 * Spawn a long-lived child process and capture its output.
 * @param command - executable to spawn.
 * @param args - argv passed without shell interpolation.
 * @param options - cwd and environment overlay.
 * @returns a handle whose `stop()` always reaps the process.
 */
export function spawnLongLived(command: string, args: string[], options: RunOptions = {}): LongLivedProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  let out = ''
  let err = ''
  child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
  child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })
  return {
    child,
    stdout: () => out,
    stderr: () => err,
    output: () => out + err,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
      killTree(child, 'SIGTERM')
      const reaped = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false) }, 8_000) }),
      ])
      if (!reaped) {
        killTree(child, 'SIGKILL')
        await exited
      }
    },
  }
}

/** Signal a child and, on POSIX, every process it spawned. */
function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (child.pid === undefined) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {
    // The child already exited between the exit check and the signal.
  }
}
