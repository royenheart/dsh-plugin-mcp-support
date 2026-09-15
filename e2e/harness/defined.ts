/**
 * Small assertion helper for reads that are provably present at runtime
 * (`boxes()[0]` after a settled read) but optional to the type checker under
 * `noUncheckedIndexedAccess`.
 */
export function defined<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`expected ${label} to be defined`)
  return value
}
