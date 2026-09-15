/**
 * Settled-read polling.
 *
 * Every visible state in this suite is read at least twice: a hop from a
 * settings write, an HTTP fetch, or a React commit can coalesce, so a single
 * DOM sample is a race by construction. `pollUntilSettled` only returns a value
 * that two consecutive reads agree on. Network-idle waits are never used.
 */
import { sleep } from './dsh-process'

export interface SettleOptions {
  timeoutMs?: number
  intervalMs?: number
  /** Description used in the timeout error. */
  label?: string
}

/**
 * Poll `read` until two consecutive reads are deeply equal and `accept` (when
 * given) accepts the value. Returns the settled value.
 */
export async function pollUntilSettled<T>(
  read: () => Promise<T>,
  options: SettleOptions & { accept?: (value: T) => boolean } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 20_000
  const intervalMs = options.intervalMs ?? 120
  const deadline = Date.now() + timeoutMs
  let previous = await read()
  while (Date.now() < deadline) {
    await sleep(intervalMs)
    const current = await read()
    if (stableEqual(previous, current) && (options.accept === undefined || options.accept(current))) {
      return current
    }
    previous = current
  }
  throw new Error(
    `settled read timed out after ${timeoutMs}ms${options.label === undefined ? '' : ` (${options.label})`}: `
    + JSON.stringify(previous),
  )
}

/** Two consecutive equal reads with no acceptance predicate. */
export function settled<T>(read: () => Promise<T>, options: SettleOptions = {}): Promise<T> {
  return pollUntilSettled(read, options)
}

/** Two consecutive equal reads that also satisfy `accept`. */
export function settledWhen<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  options: SettleOptions = {},
): Promise<T> {
  return pollUntilSettled(read, { ...options, accept })
}

export function stableEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
