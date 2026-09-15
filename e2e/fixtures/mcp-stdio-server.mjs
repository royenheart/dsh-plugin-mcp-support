/**
 * Deterministic MCP stdio server for the end-to-end suite.
 *
 * The plugin mounts the native `@deepseek-ai/dsh-mcp-client` bridge, which
 * spawns this process. Every lifecycle step it observes is appended to
 * `MCP_E2E_READY_FILE`, so a spec can prove — from outside dsh — that the
 * bridge really connected and discovered tools:
 *
 *   ready                  the process started
 *   method initialize      the handshake arrived
 *   method tools/list      tool discovery ran
 *   method tools/call      a tool call arrived
 *
 * Without `MCP_E2E_READY_FILE` the server behaves like any other MCP server.
 */
import { appendFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const readyFile = process.env.MCP_E2E_READY_FILE

/** Append one lifecycle line; a no-op without the marker file. */
function log(line) {
  if (readyFile === undefined || readyFile === '') return
  try {
    appendFileSync(readyFile, `${line}\n`)
  } catch {
    // A marker failure must never take the server down.
  }
}

const server = new McpServer(
  { name: 'e2e-stdio-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.registerTool('echo', {
  title: 'Echo',
  description: 'Returns the given text.',
  inputSchema: z.object({ text: z.string().describe('Text to echo') }),
}, async (args) => ({
  content: [{ type: 'text', text: `echo:${args.text}` }],
}))

/** Wrap the transport so every inbound JSON-RPC method is observable. */
function loggingTransport(inner) {
  return {
    start: () => inner.start(),
    close: () => inner.close(),
    send: (message) => inner.send(message),
    get onmessage() { return inner.onmessage },
    set onmessage(handler) {
      inner.onmessage = (message, extra) => {
        log(`method ${message?.method ?? 'response'}`)
        handler?.(message, extra)
      }
    },
    get onerror() { return inner.onerror },
    set onerror(handler) { inner.onerror = handler },
  }
}

log('ready')
await server.connect(loggingTransport(new StdioServerTransport()))
