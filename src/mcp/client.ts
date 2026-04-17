import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResult, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { EventEmitter } from "events";
import { createTransport, MCPTransport, TransportType, TransportConfig } from "./transports.js";
import crypto from "crypto";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Read version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8")
);
const version = packageJson.version;

export interface MCPServerConfig {
  name: string;
  transport: TransportConfig;
  // Legacy support for stdio-only configs
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: any;
  serverName: string;
  originalToolName: string;
}

/**
 * Create MCP tool name with OpenAI 64-character limit
 */
function createMCPToolName(serverName: string, toolName: string): string {
  const fullName = `mcp__${serverName}__${toolName}`;
  if (fullName.length <= 64) {
    return fullName;
  }

  // Truncate and add hash suffix to prevent collisions
  const hash = crypto.createHash('md5').update(fullName).digest('hex').substring(0, 4);
  return fullName.substring(0, 60) + hash;
}

export class MCPManager extends EventEmitter {
  private clients: Map<string, Client> = new Map();
  private transports: Map<string, MCPTransport> = new Map();
  private serverTools: Map<string, MCPTool[]> = new Map(); // Per-server tool lists
  private staleCaches: Set<string> = new Set(); // Which servers need refresh
  private debugLogFile?: string;

  setDebugLogFile(debugLogFile: string): void {
    this.debugLogFile = debugLogFile;
  }

  async addServer(config: MCPServerConfig): Promise<void> {
    try {
      // Handle legacy stdio-only configuration
      let transportConfig = config.transport;
      if (!transportConfig && config.command) {
        transportConfig = {
          type: 'stdio',
          command: config.command,
          args: config.args,
          env: config.env
        };
      }

      if (!transportConfig) {
        throw new Error('Transport configuration is required');
      }

      // Add debug log file to transport config if available
      if (this.debugLogFile && transportConfig.type === 'stdio') {
        transportConfig = {
          ...transportConfig,
          debugLogFile: this.debugLogFile
        };
      }

      // Create transport
      const transport = createTransport(transportConfig);
      this.transports.set(config.name, transport);

      // Create client
      const client = new Client(
        {
          name: "zds-ai-cli",
          version: version
        },
        {
          capabilities: {}
        }
      );

      this.clients.set(config.name, client);

      // Connect
      const sdkTransport = await transport.connect();
      await client.connect(sdkTransport);

      // List available tools
      const toolsResult = await client.listTools();

      // Register tools for this server
      const serverToolList: MCPTool[] = [];
      for (const tool of toolsResult.tools) {
        const mcpTool: MCPTool = {
          name: createMCPToolName(config.name, tool.name),
          description: tool.description || `Tool from ${config.name} server`,
          inputSchema: tool.inputSchema,
          serverName: config.name,
          originalToolName: tool.name
        };
        serverToolList.push(mcpTool);
      }
      this.serverTools.set(config.name, serverToolList);

      this.emit('serverAdded', config.name, toolsResult.tools.length);
    } catch (error) {
      // Clean up any partially initialized resources
      this.clients.delete(config.name);
      const transport = this.transports.get(config.name);
      if (transport) {
        try {
          await transport.disconnect();
        } catch (disconnectError) {
          // Ignore disconnect errors during cleanup
        }
        this.transports.delete(config.name);
      }

      this.emit('serverError', config.name, error);
      throw error;
    }
  }

  async removeServer(serverName: string): Promise<void> {
    // Remove server's tools
    this.serverTools.delete(serverName);
    this.staleCaches.delete(serverName);

    // Disconnect client
    const client = this.clients.get(serverName);
    if (client) {
      await client.close();
      this.clients.delete(serverName);
    }

    // Close transport
    const transport = this.transports.get(serverName);
    if (transport) {
      await transport.disconnect();
      this.transports.delete(serverName);
    }

    this.emit('serverRemoved', serverName);
  }

  /**
   * Mark a server's tool cache as stale. Next time tools are requested, this server will be refreshed.
   */
  invalidateCache(serverName: string): void {
    if (this.clients.has(serverName)) {
      this.staleCaches.add(serverName);
    }
  }

  /**
   * Refresh tools for a specific server by re-querying it.
   */
  async refreshServerTools(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`Server ${serverName} not connected`);
    }

    try {
      // Re-query the server for its current tools
      const toolsResult = await client.listTools();

      // Update the server's tool list
      const serverToolList: MCPTool[] = [];
      for (const tool of toolsResult.tools) {
        const mcpTool: MCPTool = {
          name: createMCPToolName(serverName, tool.name),
          description: tool.description || `Tool from ${serverName} server`,
          inputSchema: tool.inputSchema,
          serverName: serverName,
          originalToolName: tool.name
        };
        serverToolList.push(mcpTool);
      }
      this.serverTools.set(serverName, serverToolList);

      // Remove from stale cache set
      this.staleCaches.delete(serverName);

      this.emit('serverRefreshed', serverName, toolsResult.tools.length);
    } catch (error) {
      this.emit('serverError', serverName, error);
      throw error;
    }
  }

  async callTool(toolName: string, arguments_: any): Promise<CallToolResult> {
    // Find tool across all servers
    let tool: MCPTool | undefined;
    for (const toolList of this.serverTools.values()) {
      tool = toolList.find(t => t.name === toolName);
      if (tool) break;
    }

    if (!tool) {
      throw new Error(`Tool ${toolName} not found`);
    }

    const client = this.clients.get(tool.serverName);
    if (!client) {
      throw new Error(`Server ${tool.serverName} not connected`);
    }

    return await client.callTool({
      name: tool.originalToolName,
      arguments: arguments_
    }, CallToolResultSchema) as CallToolResult;
  }

  async getTools(): Promise<MCPTool[]> {
    // Refresh any stale servers before aggregating
    for (const serverName of this.staleCaches) {
      await this.refreshServerTools(serverName);
    }

    // Aggregate tools from all servers
    const allTools: MCPTool[] = [];
    for (const toolList of this.serverTools.values()) {
      allTools.push(...toolList);
    }
    return allTools;
  }

  getServers(): string[] {
    return Array.from(this.clients.keys());
  }

  async shutdown(): Promise<void> {
    const serverNames = Array.from(this.clients.keys());
    await Promise.all(serverNames.map(name => this.removeServer(name)));
  }

  getTransportType(serverName: string): TransportType | undefined {
    const transport = this.transports.get(serverName);
    return transport?.getType();
  }

  async ensureServersInitialized(): Promise<void> {
    if (this.clients.size > 0) {
      return; // Already initialized
    }

    const { loadMCPConfig } = await import('../mcp/config.js');
    const config = loadMCPConfig();

    // Initialize servers in parallel to avoid blocking
    const initPromises = config.servers.map(async (serverConfig) => {
      try {
        await this.addServer(serverConfig);
      } catch (error) {
        // Only log to debug file if configured, otherwise suppress
        if (this.debugLogFile) {
          const fs = await import('fs');
          const message = `Failed to initialize MCP server ${serverConfig.name}: ${error}\n`;
          fs.appendFileSync(this.debugLogFile, message);
        }
        // Silently ignore initialization failures
      }
    });

    await Promise.all(initPromises);
  }
}