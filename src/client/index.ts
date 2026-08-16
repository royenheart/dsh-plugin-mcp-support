/**
 * dsh-plugin-mcp-support — browser half.
 *
 * Registers one conversation view tab: an "mcp" entry in the session header
 * view-tab row (right after the trajectory "轨迹" tab). Selecting it fetches
 * the host status endpoint and shows the effective MCP server list: name,
 * transport, mounted state, and the last mount error when present.
 */
import * as React from 'react'
import type { ReactElement } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Cordis plugin name. */
export const name = 'mcp-support-client'

/** Required services: the client slot registry (provided by the runtime). */
export const inject = ['slots']

/** Host status route this browser half reads. */
export const STATUS_ENDPOINT = '/plugins/@royenheart/dsh-plugin-mcp-support/status'

/** Wire shape of one status row. */
interface McpServerStatus {
  serverName: string
  transport: 'stdio' | 'streamable-http'
  mounted: boolean
  error?: string
}

type StatusState =
  | { phase: 'loading' }
  | { phase: 'ready'; servers: McpServerStatus[] }
  | { phase: 'error'; error: string }

/** Full component props: the conversation-view runtime kit (unused; status is session-agnostic). */
type McpStatusViewProps = PropsRuntime<'conversation.view'>

const STYLE_ID = 'mcp-support-status-view-styles'

/** dsh-token styles for the full conversation-view status page. */
const STATUS_CSS = `
.mcp-status-view {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
  font-size: 13px;
  line-height: 20px;
}
.mcp-status-view-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.mcp-status-view-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.mcp-status-view-refresh {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
}
.mcp-status-view-refresh:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.mcp-status-empty {
  color: var(--dsw-alias-label-tertiary);
}
.mcp-status-error {
  color: var(--dsw-alias-state-error-primary);
}
.mcp-status-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mcp-status-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
}
.mcp-status-serverline {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.mcp-status-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.mcp-status-transport {
  flex: none;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
}
.mcp-status-dot {
  flex: none;
  width: 8px;
  height: 8px;
  margin-left: auto;
  border-radius: 50%;
  background: var(--dsw-alias-label-dimmed);
}
.mcp-status-dot-mounted {
  background: var(--dsw-alias-state-success-primary);
}
.mcp-status-detail {
  padding-left: 14px;
  color: var(--dsw-alias-state-error-primary);
  overflow-wrap: anywhere;
}
`

function installStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STATUS_CSS
  document.head.appendChild(style)
}

/** Render one server row. */
function renderServerRow(server: McpServerStatus): ReactElement {
  return React.createElement(
    'div',
    { key: server.serverName, className: 'mcp-status-row' },
    React.createElement(
      'div',
      { className: 'mcp-status-serverline' },
      React.createElement('span', { className: 'mcp-status-name' }, server.serverName),
      React.createElement('span', { className: 'mcp-status-transport' }, server.transport),
      React.createElement(
        'span',
        {
          className: server.mounted ? 'mcp-status-dot mcp-status-dot-mounted' : 'mcp-status-dot',
          title: server.mounted ? 'mounted' : 'not mounted',
        },
      ),
    ),
    server.error === undefined
      ? null
      : React.createElement('div', { className: 'mcp-status-detail' }, server.error),
  )
}

/** Render the status list for the current state. */
function renderStatusBody(state: StatusState): ReactElement {
  if (state.phase === 'loading') {
    return React.createElement('div', { className: 'mcp-status-empty' }, 'Loading MCP status…')
  }
  if (state.phase === 'error') {
    return React.createElement('div', { className: 'mcp-status-error' }, state.error)
  }
  if (state.servers.length === 0) {
    return React.createElement('div', { className: 'mcp-status-empty' }, 'No MCP servers configured.')
  }
  return React.createElement(
    'div',
    { className: 'mcp-status-list' },
    state.servers.map((server) => renderServerRow(server)),
  )
}

/**
 * Conversation-view page for the "mcp" tab.
 * @param _props - standard conversation-view kit (unused).
 * @returns the full status page element.
 */
export function McpStatusView(_props: McpStatusViewProps): ReactElement {
  const [request, setRequest] = React.useState(0)
  const [state, setState] = React.useState<StatusState>({ phase: 'loading' })

  React.useEffect(() => {
    let cancelled = false
    setState({ phase: 'loading' })
    void fetch(STATUS_ENDPOINT)
      .then(async (response) => {
        const body = await response.json() as { ok?: unknown; servers?: unknown; error?: unknown }
        if (!response.ok || body.ok !== true || !Array.isArray(body.servers)) {
          throw new Error(typeof body.error === 'string' && body.error !== ''
            ? body.error
            : `status request failed (HTTP ${response.status})`)
        }
        if (!cancelled) setState({ phase: 'ready', servers: body.servers as McpServerStatus[] })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ phase: 'error', error: error instanceof Error ? error.message : String(error) })
        }
      })
    return () => { cancelled = true }
  }, [request])

  return React.createElement(
    'div',
    { className: 'mcp-status-view' },
    React.createElement(
      'div',
      { className: 'mcp-status-view-header' },
      React.createElement('h2', { className: 'mcp-status-view-title' }, 'MCP 状态'),
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'mcp-status-view-refresh',
          onClick: () => { setRequest((previous) => previous + 1) },
        },
        '刷新',
      ),
    ),
    renderStatusBody(state),
  )
}

/**
 * Register the "mcp" tab into the conversation view row, immediately after
 * the trajectory view tab.
 * @param ctx - browser root context carrying the slots registry.
 */
export function apply(ctx: ClientContext): void {
  installStyles()
  ctx.effect(() => {
    const dispose = ctx.slots.inject('conversation.view', () => ctx.slots.register({
      name: 'conversation.view',
      id: 'mcp',
      order: 20,
      label: () => 'mcp',
    }, McpStatusView))
    return () => { dispose() }
  }, 'mcp-support-client: status view')
}
