/**
 * Hand-maintained public types for the browser half (tsdown's CJS client
 * bundle does not emit d.ts). Keep in sync with src/client/index.ts exports.
 */
import type { Context } from '@deepseek-ai/cordis'

export declare const name: string
export declare const inject: string[]
export declare function apply(ctx: Context): void

export declare const STATUS_ENDPOINT: string
