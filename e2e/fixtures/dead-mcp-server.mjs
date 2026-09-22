/**
 * A stdio MCP server that always fails: it exits non-zero before speaking the
 * protocol, so the native mcp-client's initial connection rejects. Used to
 * exercise `failOnStartupError: true` (activation must fail with the server
 * name in the message) and the "not mounted + error detail" status row.
 */
process.stderr.write('dead-mcp-server: refusing to start\n')
process.exit(3)
