/**
 * Minimal MCP stdio server for plugin e2e. Speaks the official SDK protocol
 * so `@deepseek-ai/dsh-mcp-client` can discover and call a real tool.
 */
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
