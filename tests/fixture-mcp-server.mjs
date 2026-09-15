/**
 * Minimal MCP stdio server for plugin e2e. Speaks the official v2 server SDK
 * (`@modelcontextprotocol/server`, 2026-07-28 era) so
 * `@deepseek-ai/dsh-mcp-client` can discover and call a real tool.
 */
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

serveStdio(() => {
  const server = new McpServer(
    { name: 'mcp-support-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.registerTool('echo', {
    title: 'Echo',
    description: 'Returns the given text.',
    inputSchema: z.object({ text: z.string().describe('Text to echo') }),
  }, async args => ({
    content: [{ type: 'text', text: `echo:${args.text}` }],
  }))

  return server
})
