/**
 * Browser-side helpers for the mcp-support end-to-end suite.
 *
 * Selector policy: roles, accessible names, visible text, and the plugin's own
 * class names only. No host-internal `data-*` attribute is ever asserted on —
 * those are implementation detail of a specific harness build and drift
 * between versions.
 *
 * Determinism policy: every DOM read used for an assertion goes through
 * `pollStable` (two consecutive agreeing reads) or a Playwright auto-retrying
 * expectation, and no helper ever waits on `networkidle`.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { pollStable, type WaitOptions } from './poll.ts'
import type { WebProfile } from './dsh.ts'

/** Console messages that always fail a spec, even without an explicit assert. */
const DEFAULT_FORBIDDEN_WARNINGS: RegExp[] = [
  /connection (lost|lost\.|closed|failed)/i,
  /reconnect/i,
  /gap repair/i,
  /failed to (mount|load|connect)/i,
  /uncaught/i,
]

/** A console/pageerror tripwire armed for one page. */
export interface ConsoleTripwire {
  /** `console.error` texts and pageerror messages, in arrival order. */
  errors: string[]
  /** `console.warn` texts, in arrival order. */
  warnings: string[]
  /** Messages that fail {@link ConsoleTripwire.expectClean}. */
  unexpected(): string[]
  /** Assert no unexpected console error or warning arrived. */
  expectClean(): void
}

/**
 * Arm the per-spec console tripwire.
 * @param page - page under test.
 * @param options.allowErrors - console errors matching these are tolerated.
 * @param options.allowWarnings - warnings matching these are tolerated.
 * @returns the tripwire; call `expectClean()` in the spec body.
 */
export function armConsoleTripwire(
  page: Page,
  options: { allowErrors?: RegExp[]; allowWarnings?: RegExp[] } = {},
): ConsoleTripwire {
  const errors: string[] = []
  const warnings: string[] = []
  const allowErrors = options.allowErrors ?? []
  const allowWarnings = options.allowWarnings ?? []
  page.on('pageerror', (error) => { errors.push(`pageerror: ${error.message}`) })
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`)
    if (message.type() === 'warning') warnings.push(`console.warn: ${message.text()}`)
  })
  const unexpected = (): string[] => [
    ...errors.filter((message) => !allowErrors.some((pattern) => pattern.test(message))),
    ...warnings.filter((message) => !allowWarnings.some((pattern) => pattern.test(message)))
      .filter((message) => DEFAULT_FORBIDDEN_WARNINGS.some((pattern) => pattern.test(message))),
  ]
  return {
    errors,
    warnings,
    unexpected,
    expectClean() {
      expect(unexpected(), `console/pageerror tripwire fired:\n${unexpected().join('\n')}`).toEqual([])
    },
  }
}

/**
 * Navigate to a booted web profile, dismiss the first-run dialogs, and make
 * the composer usable.
 *
 * The suite configures a deliberately invalid API key: an empty profile
 * disables Send until a provider is chosen, and the suite never asserts on a
 * model result — the prompt exists only to move the session out of its blank
 * hero state so the session header (and its view-tab row) renders. A profile
 * that already carries a provider keeps it.
 * @param page - page to navigate.
 * @param web - running web profile handle.
 * @param options.apiKey - key written into the provider dialog (default: an obviously invalid one).
 */
export async function openHarness(
  page: Page,
  web: WebProfile,
  options: { apiKey?: string } = {},
): Promise<void> {
  await page.goto(web.url, { waitUntil: 'domcontentloaded' })
  await dismissIfPresent(page, 'Internal Testing Notice', 'Continue')
  const keyDialog = page.getByRole('dialog', { name: 'Add an API key to get started' })
  const needsKey = await keyDialog.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false)
  if (needsKey) {
    await keyDialog.getByRole('textbox', { name: 'API key' }).fill(options.apiKey ?? 'sk-e2e-invalid-key')
    await keyDialog.getByRole('button', { name: 'Save and continue' }).click()
    await expect(keyDialog).toBeHidden()
  }
  await expect(page.getByRole('button', { name: 'New session' }).first()).toBeVisible()
}

/** Click a button inside a named dialog when that dialog appears. */
async function dismissIfPresent(page: Page, dialogName: string, buttonName: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: dialogName })
  const appeared = await dialog.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false)
  if (!appeared) return
  await dialog.getByRole('button', { name: buttonName }).click()
  await expect(dialog).toBeHidden()
}

/**
 * Add a workspace directory through the in-page directory picker.
 *
 * The picker is the `browse` backend, which the harness auto-resolves on a
 * headless Linux host; the path is typed rather than clicked so the state is
 * reached deterministically regardless of the temp directory name.
 * @param page - harness page.
 * @param directory - absolute directory to register as a workspace.
 * @param options.expectedLabel - sidebar label to wait for (defaults to the directory basename).
 */
export async function addWorkspace(page: Page, directory: string, options: { expectedLabel?: string } = {}): Promise<void> {
  const label = options.expectedLabel ?? directory.split('/').filter(Boolean).at(-1) ?? directory
  await page.getByRole('button', { name: 'Add workspace' }).click()
  const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Edit path' }).click()
  const pathInput = dialog.getByRole('textbox', { name: 'Edit path' })
  await pathInput.fill(directory)
  await pathInput.press('Enter')
  const open = dialog.getByRole('button', { name: 'Open' })
  await expect(open).toBeEnabled()
  await open.click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText(label, { exact: false }).first()).toBeVisible()
}

/**
 * Materialize a session and wait for the session header's view-tab row.
 *
 * A brand-new session renders as blank hero chrome with no header tabs, so the
 * suite sends one prompt through the real composer: the session leaves its
 * blank state as soon as the host accepts the turn, which is what makes the
 * `conversation.view` tab row (Chat / Trajectory / mcp) render. The model
 * answer is irrelevant and is never awaited or asserted — the failed-turn
 * state does not affect the tab row, and any console noise it produces is
 * allowed explicitly by the spec's tripwire.
 * @param page - harness page with at least one workspace registered.
 * @param prompt - task text typed into the composer.
 * @returns the conversation view tabs locator (`role=tablist`).
 */
export async function startSession(page: Page, prompt: string): Promise<Locator> {
  await page.getByRole('button', { name: 'New session' }).first().click()
  const composer = page.getByRole('textbox', { name: /Describe what you want to build/ })
  await expect(composer).toBeVisible()
  await composer.fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  const tablist = page.getByRole('tablist')
  await expect(tablist).toBeVisible({ timeout: 60_000 })
  return tablist
}

/**
 * Select the plugin's `mcp` view tab in the session header.
 *
 * The tab row sits immediately right of the trajectory tab; the plugin's own
 * tab is addressed by its registered label, not by position.
 * @param page - harness page showing a session view.
 * @returns the status view root locator.
 */
export async function openMcpTab(page: Page): Promise<Locator> {
  const tab = page.getByRole('tab', { name: 'mcp', exact: true })
  await expect(tab).toBeVisible()
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  const view = page.locator('.mcp-status-view')
  await expect(view).toBeVisible()
  return view
}

/**
 * Read a locator's text until two consecutive reads agree.
 * @param locator - element to read.
 * @param options - timeout/interval/description plus an optional acceptance predicate.
 * @returns the settled text.
 */
export async function settledText(
  locator: Locator,
  options: WaitOptions & { accept?: (text: string) => boolean } = {},
): Promise<string> {
  return await pollStable(() => locator.innerText(), { timeoutMs: 20_000, intervalMs: 150, ...options })
}

/**
 * Read a locator's ARIA snapshot until two consecutive reads agree.
 * @param locator - element to snapshot.
 * @param options - timeout/interval/description plus an optional acceptance predicate.
 * @returns the settled normalized snapshot.
 */
export async function settledAria(
  locator: Locator,
  options: WaitOptions & { accept?: (aria: string) => boolean } = {},
): Promise<string> {
  return await pollStable(() => locator.ariaSnapshot(), { timeoutMs: 20_000, intervalMs: 150, ...options })
}

/**
 * Read a locator's list of inner texts until two consecutive reads agree.
 * @param locator - element whose children are read.
 * @param options - timeout/interval/description plus an optional acceptance predicate.
 * @returns the settled list of texts.
 */
export async function settledTexts(
  locator: Locator,
  options: WaitOptions & { accept?: (texts: string[]) => boolean } = {},
): Promise<string[]> {
  return await pollStable(() => locator.allInnerTexts(), { timeoutMs: 20_000, intervalMs: 150, ...options })
}

/** One layout violation found by {@link geometryFindings}. */
export interface GeometryFinding {
  kind: 'overflow' | 'row-outside-container' | 'rows-overlap'
  detail: string
}

/**
 * Baseline-free layout invariants for a status view.
 *
 * Checks that need no recorded screenshot:
 * - the view's own content is not clipped by its box (`scrollWidth/Height`);
 * - every row box is contained by the view box;
 * - consecutive rows do not overlap.
 * @param view - the `.mcp-status-view` root.
 * @param rowSelector - plugin-owned row selector (default `.mcp-status-row`).
 * @returns the violations; an empty array means the layout is sound.
 */
export async function geometryFindings(view: Locator, rowSelector = '.mcp-status-row'): Promise<GeometryFinding[]> {
  return await view.evaluate((root, selector) => {
    const findings: { kind: 'overflow' | 'row-outside-container' | 'rows-overlap'; detail: string }[] = []
    const tolerance = 1
    if (root.scrollWidth > root.clientWidth + tolerance) {
      findings.push({
        kind: 'overflow',
        detail: `horizontal overflow: scrollWidth ${root.scrollWidth} > clientWidth ${root.clientWidth}`,
      })
    }
    if (root.scrollHeight > root.clientHeight + tolerance) {
      findings.push({
        kind: 'overflow',
        detail: `vertical overflow: scrollHeight ${root.scrollHeight} > clientHeight ${root.clientHeight}`,
      })
    }
    const container = root.getBoundingClientRect()
    const rows = [...root.querySelectorAll(selector)].map((row) => row.getBoundingClientRect())
    rows.forEach((row, index) => {
      if (row.left < container.left - tolerance || row.right > container.right + tolerance) {
        findings.push({
          kind: 'row-outside-container',
          detail: `row ${index} spans [${row.left}, ${row.right}] outside container [${container.left}, ${container.right}]`,
        })
      }
    })
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1]!
      const current = rows[index]!
      if (previous.bottom > current.top + tolerance) {
        findings.push({
          kind: 'rows-overlap',
          detail: `row ${index - 1} bottom ${previous.bottom} overlaps row ${index} top ${current.top}`,
        })
      }
    }
    return findings
  }, rowSelector)
}

/** Painted style of one status dot. */
export interface DotStyle {
  width: number
  height: number
  background: string
  visible: boolean
}

/**
 * Read the painted style of a status dot (baseline-free visual invariant).
 * @param dot - the dot element (plugin-owned `.mcp-status-dot`).
 * @returns its box size, resolved background color, and visibility.
 */
export async function dotStyle(dot: Locator): Promise<DotStyle> {
  return await dot.evaluate((element) => {
    const style = getComputedStyle(element)
    const box = element.getBoundingClientRect()
    return {
      width: box.width,
      height: box.height,
      background: style.backgroundColor,
      visible: style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0,
    }
  })
}
