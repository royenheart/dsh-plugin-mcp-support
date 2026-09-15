/**
 * Deterministic MCP streamable-http server for the end-to-end suite.
 *
 * Unlike the stdio fixture this process is owned by the test harness, because
 * a remote transport has no child process for dsh to spawn: the scenario
 * config points at `http://127.0.0.1:${MCP_E2E_PORT}/mcp`.
 *
 * `MCP_E2E_READY_FILE` receives:
 *
 *   listening <port>                  the fixture is accepting connections
 *   method initialize                 the handshake arrived over HTTP
 *   method notifications/initialized  the client acknowledged
 *   method tools/list                 tool discovery ran over HTTP
 *
 * The transport is stateless (no session id), which is the simplest shape the
 * native client accepts and keeps the fixture free of session bookkeeping.
 */
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { z } from 'zod'

const readyFile = process.env.MCP_E2E_READY_FILE
const port = Number(process.env.MCP_E2E_PORT ?? 0)
if (!Number.isInteger(port) || port <= 0) {
  throw new Error('MCP_E2E_PORT must be a fixed port chosen by the harness')
}

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
  { name: 'e2e-http-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.registerTool('echo', {
  title: 'Echo',
  description: 'Returns the given text.',
  inputSchema: z.object({ text: z.string().describe('Text to echo') }),
}, async (args) => ({
  content: [{ type: 'text', text: `echo:${args.text}` }],
}))

const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
await server.connect(transport)

createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined
  if (body !== undefined) {
    try {
      const parsed = JSON.parse(body.toString('utf8'))
      const methods = Array.isArray(parsed) ? parsed.map((entry) => entry?.method) : [parsed?.method]
      for (const method of methods) log(`method ${method ?? 'response'}`)
    } catch {
      // Non-JSON bodies (for example an SSE priming request) carry no method.
    }
  }
  const headers = Object.entries(request.headers)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])
  const webRequest = new Request(`http://127.0.0.1:${port}${request.url ?? '/mcp'}`, {
    method: request.method,
    headers,
    body,
    duplex: 'half',
  })
  try {
    const webResponse = await transport.handleRequest(webRequest)
    response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()))
    response.end(Buffer.from(await webResponse.arrayBuffer()))
  } catch (error) {
    log(`error ${error instanceof Error ? error.message : String(error)}`)
    response.writeHead(500, { 'content-type': 'text/plain' })
    response.end('fixture failure')
  }
}).listen(port, '127.0.0.1', () => { log(`listening ${port}`) })
