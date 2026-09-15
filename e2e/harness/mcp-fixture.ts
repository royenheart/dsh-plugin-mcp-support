/**
 * MCP fixture servers and their readiness markers.
 *
 * Both fixtures append a line per observed lifecycle step to
 * `MCP_E2E_READY_FILE`. The markers are the authoritative proof that the
 * plugin really mounted the native bridge: a stdio fixture can only write
 * `ready` if the native client spawned it, and either fixture only writes
 * `method tools/list` if the connection completed tool discovery.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { sleep, stopProcess } from './dsh-process'
import { httpFixtureScript } from './config'
import { settledWhen } from './poll'

/** All marker lines written so far; a missing file reads as empty. */
export function readMarker(file: string): string[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')
  } catch {
    return []
  }
}

/** Wait until two consecutive reads agree and the predicate accepts them. */
export async function waitForMarker(
  file: string,
  predicate: (lines: string[]) => boolean,
  options: { timeoutMs?: number; label?: string } = {},
): Promise<string[]> {
  return await settledWhen(() => Promise.resolve(readMarker(file)), predicate, {
    timeoutMs: options.timeoutMs ?? 30_000,
    label: options.label ?? `marker ${path.basename(file)}`,
  })
}

/** Wait for a marker line matching `pattern`. */
export function waitForMarkerLine(file: string, pattern: RegExp, timeoutMs = 30_000): Promise<string[]> {
  return waitForMarker(file, (lines) => lines.some((line) => pattern.test(line)), { timeoutMs, label: `${file} =~ ${String(pattern)}` })
}

/** Ask the OS for a free TCP port (the fixture rebinds it immediately). */
export async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('could not allocate a port'))
        return
      }
      const { port } = address
      server.close(() => { resolve(port) })
    })
  })
}

export interface HttpFixtureHandle {
  url: string
  port: number
  markerFile: string
  output(): string
  stop(): Promise<void>
}

/**
 * Start the streamable-http MCP fixture. Unlike the stdio fixture this process
 * is owned by the test harness, not by dsh: the scenario config must point at
 * its URL.
 */
export async function startHttpFixture(options: { markerFile: string; port?: number }): Promise<HttpFixtureHandle> {
  const port = options.port ?? await getFreePort()
  // The fixture appends to the marker; its directory must exist before the
  // process starts (it never creates one, so a failure here would be silent).
  fs.mkdirSync(path.dirname(options.markerFile), { recursive: true })
  let output = ''
  const child: ChildProcess = spawn(process.execPath, [httpFixtureScript()], {
    cwd: path.dirname(httpFixtureScript()),
    env: { ...process.env, MCP_E2E_PORT: String(port), MCP_E2E_READY_FILE: options.markerFile },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })

  await waitForMarkerLine(options.markerFile, new RegExp(`listening ${port}\\b`), 20_000).catch(async (error: unknown) => {
    await stopProcess(child)
    throw new Error(`${String(error)}\nhttp fixture output:\n${output}`)
  })
  await waitForHttpOk(`http://127.0.0.1:${port}/mcp`)

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    markerFile: options.markerFile,
    output: () => output,
    stop: () => stopProcess(child),
  }
}

/** The streamable-http endpoint answers a bare GET with an SSE/JSON status once listening. */
async function waitForHttpOk(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: 'GET', headers: { accept: 'application/json, text/event-stream' }, signal: AbortSignal.timeout(2_000) })
      if (response.status > 0) {
        await response.body?.cancel()
        return
      }
    } catch {
      // not listening yet
    }
    await sleep(150)
  }
  throw new Error(`fixture never answered at ${url}`)
}
