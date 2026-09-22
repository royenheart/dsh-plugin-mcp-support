/**
 * Playwright configuration for the mcp-support end-to-end suite.
 *
 * Mirrors the DeepSeek Harness web lane's browser tooling: Chromium, one
 * worker, no retries (a flake must be fixed, not retried), a pinned viewport,
 * one explicit locale, and role/ARIA oriented assertions. Specs boot real
 * `dsh` profiles, so the per-test budget is generous while every individual
 * wait inside a spec stays bounded.
 */
import { defineConfig } from '@playwright/test'
import { artifactsDir } from './helpers/env.ts'

const artifacts = artifactsDir()

export default defineConfig({
  testDir: './specs',
  // Artifacts stay out of the plugin tree's committed surface.
  outputDir: `${artifacts}/test-results`,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: process.env.CI !== undefined,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: `${artifacts}/report`, open: 'never' }],
  ],
  use: {
    browserName: 'chromium',
    viewport: { width: 1280, height: 900 },
    // One explicit language keeps role names and message copy stable.
    locale: 'en-US',
    timezoneId: 'UTC',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'chromium' },
  ],
})
