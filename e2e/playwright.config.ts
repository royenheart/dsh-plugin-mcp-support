/**
 * Playwright + Chromium end-to-end suite for @royenheart/dsh-plugin-mcp-support.
 *
 * The suite drives a real `dsh web` profile (the shipped `web` bundle plus the
 * plugin under test) in Chromium, and a real headless/CLI profile for the
 * non-browser surfaces. Servers are managed per spec file, so Playwright's own
 * `webServer` option is intentionally unused and specs never wait on network
 * idle (the web client holds an SSE stream open, so network-idle never fires).
 */
import { defineConfig } from '@playwright/test'

/** Bundled Chromium needs `--no-sandbox` when the runner itself is root. */
const runningAsRoot = process.platform === 'linux'
  && typeof process.getuid === 'function'
  && process.getuid() === 0

export default defineConfig({
  testDir: './specs',
  globalSetup: './global-setup.ts',
  // Every scenario owns a dsh home and a booted profile; run files serially.
  fullyParallel: false,
  workers: 1,
  // No retries: a flake here means a real nondeterminism to fix, not to mask.
  retries: 0,
  forbidOnly: process.env.CI !== undefined,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  outputDir: 'test-results/artifacts',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'test-results/html' }],
  ],
  use: {
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    // One explicit language for role locators; the plugin's own copy is
    // Chinese regardless of host locale.
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions: runningAsRoot ? { args: ['--no-sandbox'] } : {},
  },
  projects: [{ name: 'chromium' }],
})
