#!/usr/bin/env -S bun run
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PACKAGE_VERSION } from "./index";
import { createContext } from "./tools/context";
import { registerTools } from "./tools/index";

/**
 * stdio MCP server entrypoint (package.json `bin.mcp-server`). Wires the shared
 * `src/device/` core behind ~17 tools over stdin/stdout. The device context
 * (AndroidCli + AdbWrapper + baselineEstablished set) lives for the process.
 *
 * Usage: `openmobile mcp-server` or `bun src/mcp-server.ts`
 */
const server = new McpServer({
  name: "@openmobile/android-device-bridge",
  version: PACKAGE_VERSION,
});

registerTools(server, createContext());

const transport = new StdioServerTransport();
await server.connect(transport);
