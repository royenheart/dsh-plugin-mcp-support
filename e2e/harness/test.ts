/**
 * The suite's Playwright test object.
 *
 * The `page` fixture is wrapped with the console/pageerror tripwire: any
 * unexpected browser error fails the test that produced it. The web client's
 * reconnect machinery can silently heal a broken status fetch, so a green
 * assertion without this tripwire would not certify the wire.
 *
 * CLI-only specs have no browser surface; they use `assertCliTripwire`, which
 * applies the same "fail on unexpected internal error" rule to the process
 * output (unexpected stack traces / module errors) instead.
 */
import { test as base, expect } from '@playwright/test'

/**
 * Console errors this suite tolerates. Keep this list empty unless a message is
 * provably environmental; every entry must name the owner that will remove it.
 */
export const EXPECTED_CONSOLE_ERRORS: RegExp[] = []

export const test = base.extend({
  page: async ({ page }, use) => {
    const failures: string[] = []
    page.on('pageerror', (error) => { failures.push(`pageerror: ${error.message}`) })
    page.on('console', (message) => {
      if (message.type() === 'error') failures.push(`console.error: ${message.text()}`)
    })
    await use(page)
    const unexpected = failures.filter((entry) => !EXPECTED_CONSOLE_ERRORS.some((pattern) => pattern.test(entry)))
    expect(unexpected, 'console/pageerror tripwire').toEqual([])
  },
})

export { expect }

/** Patterns a CLI boot may print without failing the CLI tripwire. */
export const CLI_ALLOWED_NOISE: RegExp[] = [
  /MISSING_CREDENTIAL/,
  /no API key for provider route/,
  /TRANSPORT: DeepSeek Messages transport failed/,
]

/**
 * Shapes that mean "the process hit an internal error", as opposed to ordinary
 * output that merely mentions the word error (a passing test named
 * "…throws a clear error", for example).
 */
const CLI_ERROR_SHAPES: RegExp[] = [
  /^(?:Error|TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError)\b/,
  /\bERR_[A-Z_]+\b/,
  /\b(?:uncaught|unhandled)\b/i,
  /\bplugin tree failed to load\b/,
]

/**
 * Fail when a CLI run printed an internal error the scenario did not expect.
 * `expected` carries the scenario's own diagnostics (its validation messages
 * and the like); everything else that looks like a crash is a failure.
 *
 * Indented lines are stack frames or quoted source context and are ignored: a
 * boot that is *supposed* to fail still prints its trace, and the scenario's
 * own message assertions cover that path.
 */
export function assertCliTripwire(output: string, expected: RegExp[] = []): void {
  const allowed = [...CLI_ALLOWED_NOISE, ...expected]
  const unexpected = output.split('\n').filter((line) => {
    if (line.trim() === '') return false
    if (/^\s/.test(line)) return false
    if (!CLI_ERROR_SHAPES.some((pattern) => pattern.test(line))) return false
    return !allowed.some((pattern) => pattern.test(line))
  })
  expect(unexpected, 'cli tripwire: unexpected internal error output').toEqual([])
}
