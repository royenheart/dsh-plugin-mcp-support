/**
 * C5 — the session-agnostic status route.
 *
 * Feature ledger row: `status-route`.
 *
 * The route is served by the host `webServer` seam registered through the
 * plugin's optional `ctx.inject(['webServer'])` layer. Assertions are made over
 * HTTP from the browser context, so they cover the wire the browser half
 * actually consumes: GET/HEAD answered, other methods refused, and the route is
 * exact (no prefix matching).
 */
import path from 'node:path'
import { test, expect } from '../harness/test'
import { Scenario, scenarioHooks } from '../harness/scenario'
import { stdioFixture } from '../harness/config'
import { STATUS_ENDPOINT, openApp } from '../harness/app'
import { defined } from '../harness/defined'

const scenario = new Scenario({
  id: 'status-route',
  servers: (context) => [stdioFixture('alpha', { markerFile: path.join(context.markersDir, 'alpha.txt') })],
  settings: null,
})
scenarioHooks(test, scenario)

function routeUrl(page: { url(): string }): string {
  return new URL(STATUS_ENDPOINT, page.url()).toString()
}

test('GET returns the documented JSON body', async ({ page }) => {
  await openApp(page, scenario.url)
  const response = await page.context().request.get(routeUrl(page))
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toContain('application/json')
  const body = await response.json() as { ok: boolean; servers: Array<Record<string, unknown>> }
  expect(body.ok).toBe(true)
  expect(body.servers).toHaveLength(1)
  const server = defined(body.servers[0], 'first status server')
  expect(Object.keys(server).sort()).toEqual(['mounted', 'serverName', 'transport'])
  expect(server).toEqual({ serverName: 'alpha', transport: 'stdio', mounted: true })
})

test('HEAD is answered without a body', async ({ page }) => {
  await openApp(page, scenario.url)
  const response = await page.context().request.head(routeUrl(page))
  expect(response.status()).toBe(200)
  expect((await response.body()).byteLength).toBe(0)
})

test('every other method is refused with 405', async ({ page }) => {
  await openApp(page, scenario.url)
  for (const method of ['post', 'put', 'delete'] as const) {
    const response = await page.context().request[method](routeUrl(page))
    expect(response.status(), `${method.toUpperCase()} must be refused`).toBe(405)
    expect(await response.json()).toEqual({ ok: false, error: 'method not allowed' })
  }
})

test('the route is exact: a longer path does not resolve to it', async ({ page }) => {
  await openApp(page, scenario.url)
  const response = await page.context().request.get(`${routeUrl(page)}/extra`)
  expect(response.status()).toBe(404)
})
