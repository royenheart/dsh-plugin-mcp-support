/**
 * Reach-state helpers for the browser surface.
 *
 * Every journey starts from the tokenized URL `dsh web` prints and reaches the
 * session view through real user gestures (dismiss the first-run dialogs,
 * choose a workspace in the directory picker, commit one composer turn, then
 * select the `mcp` tab). Nothing waits for network idle: the web app holds an
 * SSE stream open, so network-idle never resolves. State is read through
 * settled polls (two consecutive equal reads), never a single DOM sample.
 */
import type { Locator, Page } from '@playwright/test'
import { settledWhen } from './poll'
import { defined } from './defined'

export const STATUS_ENDPOINT = '/plugins/@royenheart/dsh-plugin-mcp-support/status'

/** Tab label the plugin registers. */
export const MCP_TAB_LABEL = 'mcp'

/** Composer placeholder changes between the hero and the docked input. */
const COMPOSER_NAME = /Describe what you want to build|Message or run a task/

/** Open the web app at its tokenized URL and clear any first-run dialog. */
export async function openApp(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'New session' }).first().waitFor({ state: 'visible', timeout: 60_000 })
  await dismissFirstRunDialogs(page)
}

/**
 * Dismiss whichever first-run dialog this home shows (the internal-testing
 * notice and the API-key prompt). Both persist their answer, so later tests in
 * the same home see none.
 *
 * The two dialogs can overlap in the DOM and appear back-to-back, so the loop
 * looks only at *visible* dialogs, waits for a quiet window in which neither a
 * dialog nor a modal mask is visible, and never returns while a mask could
 * still swallow the next click.
 */
export async function dismissFirstRunDialogs(page: Page): Promise<void> {
  const deadline = Date.now() + 30_000
  let quietRounds = 0
  while (Date.now() < deadline) {
    const dialogs = await visibleDialogs(page)
    if (dialogs.length === 0) {
      const masked = await anyVisibleModalMask(page)
      if (!masked) {
        quietRounds += 1
        if (quietRounds >= 3) return
      } else {
        quietRounds = 0
      }
      await page.waitForTimeout(300)
      continue
    }
    quietRounds = 0
    const dialog = defined(dialogs[0], 'first visible dialog')
    let dismissed = false
    for (const name of ['Continue', 'Configure later']) {
      const button = dialog.getByRole('button', { name, exact: true })
      if (await button.count() > 0 && await button.isVisible()) {
        await button.click()
        dismissed = true
        break
      }
    }
    if (!dismissed) {
      throw new Error(`unrecognized first-run dialog: ${JSON.stringify((await dialog.innerText()).slice(0, 200))}`)
    }
    await dialog.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {})
  }
  throw new Error('first-run dialogs never settled')
}

/** Every dialog that is actually visible right now. */
async function visibleDialogs(page: Page): Promise<Locator[]> {
  const all = await page.getByRole('dialog').all()
  const visible: Locator[] = []
  for (const dialog of all) {
    if (await dialog.isVisible()) visible.push(dialog)
  }
  return visible
}

/**
 * A modal mask still mounted (even with no dialog) intercepts every click, so
 * readiness means "no visible mask". CSS-module local-name anchors are the
 * sanctioned way to read the app's own frame/mask elements.
 */
async function anyVisibleModalMask(page: Page): Promise<boolean> {
  const masks = await page.locator('[class*="_mask_"]').all()
  for (const mask of masks) {
    if (await mask.isVisible()) return true
  }
  return false
}

/** Choose the scenario workspace through the directory picker. */
export async function selectWorkspace(page: Page, workspacePath: string): Promise<void> {
  await page.getByRole('button', { name: 'Add workspace' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
  await dialog.waitFor({ state: 'visible', timeout: 20_000 })
  await dialog.getByRole('button', { name: 'Edit path' }).click()
  const pathBox = dialog.getByRole('textbox', { name: 'Edit path' })
  await pathBox.fill(workspacePath)
  await pathBox.press('Enter')
  await dialog.getByRole('button', { name: 'Open', exact: true }).click()
  await dialog.waitFor({ state: 'hidden', timeout: 30_000 })
}

/**
 * Reach the session view whose header carries the view-tab row.
 *
 * A blank session stays in the hero phase, where the tab row does not exist,
 * so one composer turn is committed. The run is keyless by construction
 * (`harness/dsh-process.ts` scrubs model credentials from every spawned dsh
 * process), which makes the turn fail with MISSING_CREDENTIAL while the user
 * message still persists — the session becomes non-blank and the tab row
 * appears deterministically.
 */
export async function openSessionView(
  page: Page,
  options: { workspacePath: string; seedText?: string },
): Promise<void> {
  const mcpTab = page.getByRole('tab', { name: MCP_TAB_LABEL, exact: true })
  if (await mcpTab.count() > 0 && await mcpTab.first().isVisible()) return

  const chooseWorkspace = page.getByRole('button', { name: 'Choose workspace' })
  if (await chooseWorkspace.count() > 0 && await chooseWorkspace.first().isVisible()) {
    await selectWorkspace(page, options.workspacePath)
  }

  if (!(await mcpTab.count() > 0 && await mcpTab.first().isVisible())) {
    const composer = page.getByRole('textbox', { name: COMPOSER_NAME }).first()
    await composer.waitFor({ state: 'visible', timeout: 30_000 })
    await composer.fill(options.seedText ?? 'e2e: reach the session view')
    await composer.press('Enter')
  }

  await mcpTab.first().waitFor({ state: 'visible', timeout: 60_000 })
}

/** Open the session view and select the plugin's tab. */
export async function openMcpView(
  page: Page,
  options: { workspacePath: string; seedText?: string },
): Promise<void> {
  await openSessionView(page, options)
  const tab = page.getByRole('tab', { name: MCP_TAB_LABEL, exact: true })
  if (!(await tab.getAttribute('aria-selected'))?.includes('true')) {
    await tab.click()
  }
  await page.locator('.mcp-status-view').first().waitFor({ state: 'visible', timeout: 30_000 })
}

export interface StatusRow {
  name: string | null
  transport: string | null
  /** `title` of the plugin's own mounted-state dot ('mounted' | 'not mounted'). */
  mounted: string | null
  error: string | null
  text: string
}

export interface StatusSnapshot {
  viewText: string
  heading: string | null
  refreshLabel: string | null
  rows: StatusRow[]
}

/**
 * Read the whole visible status page in one DOM pass. Class selectors target
 * the plugin's own markup (its public CSS contract); no host `data-*`
 * attribute is touched.
 */
export async function readStatus(page: Page): Promise<StatusSnapshot | null> {
  const view = page.locator('.mcp-status-view')
  if (await view.count() === 0) return null
  return await view.first().evaluate((root) => {
    const clean = (value: string | null | undefined): string | null =>
      value === null || value === undefined ? null : value.replace(/\s+/g, ' ').trim()
    const rows = [...root.querySelectorAll('.mcp-status-row')].map((row) => ({
      name: clean(row.querySelector('.mcp-status-name')?.textContent),
      transport: clean(row.querySelector('.mcp-status-transport')?.textContent),
      mounted: clean(row.querySelector('.mcp-status-dot')?.getAttribute('title')),
      error: clean(row.querySelector('.mcp-status-detail')?.textContent),
      text: clean(row.textContent) ?? '',
    }))
    return {
      viewText: clean(root.textContent) ?? '',
      heading: clean(root.querySelector('h2')?.textContent),
      refreshLabel: clean(root.querySelector('button')?.textContent),
      rows,
    }
  })
}

/** Settled status snapshot; optionally wait until `accept` holds. */
export async function statusSnapshot(
  page: Page,
  accept?: (snapshot: StatusSnapshot) => boolean,
  options: { timeoutMs?: number; label?: string } = {},
): Promise<StatusSnapshot> {
  const snapshot = await settledWhen(
    () => readStatus(page),
    (value): value is StatusSnapshot => value !== null && (accept === undefined || accept(value)),
    { timeoutMs: options.timeoutMs ?? 30_000, label: options.label ?? 'mcp status view' },
  )
  return snapshot as StatusSnapshot
}

/** Click the plugin's own refresh button and settle on the re-fetched state. */
export async function refreshStatus(page: Page): Promise<void> {
  await page.getByRole('button', { name: '刷新', exact: true }).click()
}

/** Wire shape of the plugin's status route. */
export interface StatusPayloadServer {
  serverName: string
  transport: string
  mounted: boolean
  error?: string
}

export interface StatusPayload {
  ok: boolean
  servers: StatusPayloadServer[]
}

/**
 * Read the authoritative host state through the status route, sharing the
 * browser context's cookies. Used to cross-check what the view renders.
 */
export async function fetchStatus(page: Page): Promise<StatusPayload> {
  const url = new URL(STATUS_ENDPOINT, page.url()).toString()
  const response = await page.context().request.get(url)
  if (!response.ok()) {
    throw new Error(`status route answered HTTP ${response.status()}`)
  }
  return await response.json() as StatusPayload
}

/**
 * Wait until the host has applied a live settings change. The view only
 * re-fetches on mount and on the refresh control, so a live-sync scenario gates
 * on the authoritative route first and then asks the UI to refresh — never the
 * other way round, which would race the settings watcher.
 */
export async function waitForHostServers(
  page: Page,
  accept: (servers: StatusPayloadServer[]) => boolean,
  options: { timeoutMs?: number; label?: string } = {},
): Promise<StatusPayloadServer[]> {
  return await settledWhen(
    async () => (await fetchStatus(page)).servers,
    accept,
    { timeoutMs: options.timeoutMs ?? 30_000, label: options.label ?? 'host server list' },
  )
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Viewport-relative boxes for every element a locator matches. */
export async function boxes(locator: Locator): Promise<Box[]> {
  return await locator.evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }))
}

/** True when two boxes share area. */
export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** Assertion-friendly overlap report for a list of boxes. */
export function overlappingPairs(items: Box[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = []
  for (const [i, first] of items.entries()) {
    for (const [j, second] of items.entries()) {
      if (j <= i) continue
      if (overlaps(first, second)) pairs.push([i, j])
    }
  }
  return pairs
}
