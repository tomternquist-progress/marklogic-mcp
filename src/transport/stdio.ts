import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export async function startStdioTransport(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The server now reads JSON-RPC from stdin and writes to stdout.
  // All logging goes to stderr via Winston to avoid corrupting the stream.
}
