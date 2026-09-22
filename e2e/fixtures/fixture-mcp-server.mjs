/**
 * Minimal MCP stdio server for the mcp-support end-to-end suite: one `echo`
 * tool over the official SDK protocol, so the plugin's native
 * `@deepseek-ai/dsh-mcp-client` child performs a real connect + tool
 * discovery and the status route reports `mounted: true`.
 *
 * Spawned with cwd at the plugin checkout, so `@modelcontextprotocol/sdk` and
 * `zod` resolve from the repository's devDependencies.
 */
import { writeFile } from 'node:fs/promises'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer(
  { name: 'mcp-support-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.registerTool('echo', {
  title: 'Echo',
  description: 'Returns the given text.',
  inputSchema: { text: z.string().describe('Text to echo') },
}, async args => ({
  content: [{ type: 'text', text: `echo:${args.text}` }],
}))

const transport = new StdioServerTransport()
await server.connect(transport)

// Readiness marker for the headless spec: a file written only after the
// protocol connection is established proves the plugin really spawned and
// connected this child, without depending on `/proc` sampling races.
const marker = process.env.MCP_FIXTURE_MARKER
if (marker !== undefined && marker !== '') {
  await writeFile(marker, `${process.pid}\n`, 'utf8')
}
