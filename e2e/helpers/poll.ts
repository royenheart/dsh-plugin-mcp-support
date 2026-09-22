/**
 * Deterministic waiting for the mcp-support end-to-end suite.
 *
 * Two rules from the harness browser lane are enforced here:
 *
 * 1. never wait on network idle — every wait is a predicate over an explicit
 *    observation (a DOM read, an HTTP response, a log line);
 * 2. never assert on a single transient sample — `pollStable` requires two
 *    consecutive equal reads before it returns, so a DOM or HTTP read that is
 *    still converging (a React commit, a child mount flipping `mounted`) can
 *    never become the asserted value.
 */

/** Sleep for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Options shared by {@link waitFor} and {@link pollStable}. */
export interface WaitOptions {
  timeoutMs?: number
  intervalMs?: number
  /** Human-readable observation name used in the timeout error. */
  description?: string
}

/**
 * Poll `read` until `predicate` accepts the value.
 * @param read - observation, re-run on every attempt.
 * @param predicate - acceptance test over the observation.
 * @param options - timeout, interval, and description.
 * @returns the accepted value.
 * @throws when the deadline passes without acceptance.
 */
export async function waitFor<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  options: WaitOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const intervalMs = options.intervalMs ?? 150
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      last = await read()
      if (predicate(last)) return last
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  const detail = lastError === undefined ? `last value: ${JSON.stringify(last)}` : `last error: ${String(lastError)}`
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${options.description ?? 'observation'} (${detail})`)
}

/**
 * Poll `read` until two consecutive reads compare equal.
 *
 * This is the suite's settlement primitive: a streaming/async UI can always
 * coalesce one more update, so the first sample is never trustworthy. Pair it
 * with `accept` whenever a not-yet-updated state (a loading placeholder, a
 * still-empty list) would otherwise be stable by construction — the predicate
 * gates which values are eligible for the two-read agreement.
 * @param read - observation, re-run on every attempt.
 * @param options - timeout, interval, description, equality comparator, and an
 * optional acceptance predicate a value must satisfy before it can settle.
 * @returns the settled value (the second of the two agreeing reads).
 */
export async function pollStable<T>(
  read: () => T | Promise<T>,
  options: WaitOptions & { equals?: (a: T, b: T) => boolean; accept?: (value: T) => boolean } = {},
): Promise<T> {
  const equals = options.equals ?? ((a: T, b: T) => JSON.stringify(a) === JSON.stringify(b))
  const timeoutMs = options.timeoutMs ?? 30_000
  const intervalMs = options.intervalMs ?? 150
  const deadline = Date.now() + timeoutMs
  let previous: { value: T } | undefined
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await read()
      if (options.accept !== undefined && !options.accept(value)) {
        previous = undefined
      } else if (previous !== undefined && equals(previous.value, value)) {
        return value
      } else {
        previous = { value }
      }
    } catch (error) {
      lastError = error
      previous = undefined
    }
    await sleep(intervalMs)
  }
  const detail = lastError === undefined ? 'reads never agreed' : `last error: ${String(lastError)}`
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${options.description ?? 'stable read'} to settle (${detail})`)
}
