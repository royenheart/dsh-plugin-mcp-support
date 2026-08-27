/**
 * Conversation-view tab: slot registration, status fetch, empty/error/ready UX, refresh.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { JSDOM } from 'jsdom'
import { Context, Service } from '@deepseek-ai/cordis'

function installDom() {
  if (globalThis.document !== undefined) return
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', { url: 'http://127.0.0.1/' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.Node = dom.window.Node
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
}

installDom()

const { McpStatusView, apply, inject, name, STATUS_ENDPOINT } = await import('../src/client/index.ts')

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

async function mount(fetchImpl) {
  globalThis.fetch = fetchImpl
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(McpStatusView, {}))
  })
  await act(async () => { await Promise.resolve() })
  return {
    host,
    async unmount() {
      await act(async () => { root.unmount() })
      host.remove()
    },
  }
}

test('loading, empty, error, and mounted rows are the visible MCP status UX', async () => {
  let pending
  const blocked = new Promise(resolve => { pending = resolve })
  const loading = await mount(async () => blocked)
  assert.match(loading.host.textContent ?? '', /MCP 状态/)
  assert.match(loading.host.textContent ?? '', /Loading MCP status/)
  assert.equal(loading.host.querySelector('button')?.textContent, '刷新')
  pending(jsonResponse({ ok: true, servers: [] }))
  await act(async () => { await Promise.resolve() })
  assert.match(loading.host.textContent ?? '', /No MCP servers configured/)
  await loading.unmount()

  const failed = await mount(async () => jsonResponse({ ok: false, error: 'route missing' }, 500))
  await act(async () => { await Promise.resolve() })
  assert.match(failed.host.textContent ?? '', /route missing|status request failed/)
  await failed.unmount()

  const ready = await mount(async () => jsonResponse({
    ok: true,
    servers: [
      { serverName: 'alpha', transport: 'stdio', mounted: true },
      { serverName: 'beta', transport: 'streamable-http', mounted: false, error: 'connect ECONNREFUSED' },
    ],
  }))
  await act(async () => { await Promise.resolve() })
  const text = ready.host.textContent ?? ''
  assert.match(text, /alpha/)
  assert.match(text, /stdio/)
  assert.match(text, /beta/)
  assert.match(text, /streamable-http/)
  assert.match(text, /connect ECONNREFUSED/)
  const dots = [...ready.host.querySelectorAll('.mcp-status-dot')]
  assert.equal(dots.length, 2)
  assert.ok(dots[0].className.includes('mcp-status-dot-mounted'))
  assert.equal(dots[0].getAttribute('title'), 'mounted')
  assert.equal(dots[1].getAttribute('title'), 'not mounted')
  await ready.unmount()
})

test('refresh button fetches status again', async () => {
  let calls = 0
  const payloads = [
    { ok: true, servers: [] },
    { ok: true, servers: [{ serverName: 'after', transport: 'stdio', mounted: true }] },
  ]
  const view = await mount(async (url) => {
    assert.equal(String(url), STATUS_ENDPOINT)
    return jsonResponse(payloads[Math.min(calls++, payloads.length - 1)])
  })
  await act(async () => { await Promise.resolve() })
  assert.match(view.host.textContent ?? '', /No MCP servers configured/)

  await act(async () => {
    view.host.querySelector('button')?.click()
  })
  await act(async () => { await Promise.resolve() })
  assert.match(view.host.textContent ?? '', /after/)
  assert.equal(calls, 2)
  await view.unmount()
})

class MockSlots extends Service {
  constructor(ctx) {
    super(ctx, 'slots')
    this.registrations = []
  }
  inject(name, factory) {
    if (name !== 'conversation.view') throw new Error(`unexpected slot ${name}`)
    return factory()
  }
  register(options, Component) {
    this.registrations.push({ options, Component })
    return () => {}
  }
}

test('client apply registers the mcp conversation-view tab and injects styles', async () => {
  const ctx = new Context()
  await ctx.plugin(MockSlots)
  await ctx.plugin({ name, inject, apply })
  const registration = ctx.get('slots').registrations[0]
  assert.equal(registration.options.name, 'conversation.view')
  assert.equal(registration.options.id, 'mcp')
  assert.equal(registration.options.order, 20)
  assert.equal(registration.options.label(), 'mcp')
  assert.equal(registration.Component, McpStatusView)
  assert.ok(document.getElementById('mcp-support-status-view-styles'))
  await ctx.fiber.dispose()
})
