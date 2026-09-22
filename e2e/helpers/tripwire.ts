/**
 * Process-output tripwire for the CLI and headless specs.
 *
 * The browser specs arm a console/pageerror tripwire on the page; a spec that
 * never opens a browser arms the equivalent on the real `dsh` process output,
 * so every spec in the suite still fails loudly on an unexpected host
 * diagnostic instead of only asserting the happy path.
 */
import type { RunResult } from './process.ts'

/** Lines that always fail unless explicitly allowed. */
const TRIPWIRE_PATTERNS: RegExp[] = [
  // The harness's own diagnostic prefix is lowercase `dsh: warning:`; a
  // capital-W Node runtime warning (e.g. NO_COLOR vs FORCE_COLOR) is
  // environment noise and is filtered separately below.
  /warning:/,
  /did not activate/i,
  /pending \(waiting for service/i,
  /\buncaught\b/i,
  /\bunhandled\b/i,
]

/** Environment noise no spec should fail on. */
const RUNTIME_NOISE: RegExp[] = [
  /^\(node:\d+\)/,
  /NO_COLOR/,
]

/** A process-output tripwire. */
export interface ProcessTripwire {
  /** Non-empty output lines, in arrival order. */
  lines: string[]
  /** Lines that fail {@link ProcessTripwire.expectClean}. */
  unexpected(): string[]
  /** Assert no unexpected diagnostic line was printed. */
  expectClean(): void
}

/**
 * Arm a tripwire over one finished `dsh` run.
 * @param result - captured run result.
 * @param options.allow - tripwire-matching lines that are expected in this spec.
 * @returns the tripwire; call `expectClean()` in the spec body.
 */
export function processTripwire(result: RunResult, options: { allow?: RegExp[] } = {}): ProcessTripwire {
  const allow = options.allow ?? []
  const lines = result.combined.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const unexpected = (): string[] => lines
    .filter((line) => !RUNTIME_NOISE.some((pattern) => pattern.test(line)))
    .filter((line) => TRIPWIRE_PATTERNS.some((pattern) => pattern.test(line)))
    .filter((line) => !allow.some((pattern) => pattern.test(line)))
  return {
    lines,
    unexpected,
    expectClean() {
      const found = unexpected()
      if (found.length === 0) return
      throw new Error(`process tripwire fired:\n${found.join('\n')}`)
    },
  }
}
