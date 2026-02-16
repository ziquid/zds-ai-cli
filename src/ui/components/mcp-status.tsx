import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { getMCPManager } from "../../grok/tools.js";
import { MCPTool } from "../../mcp/client.js";

interface MCPStatusProps {}

export const MCPStatus = React.memo(function MCPStatus({}: MCPStatusProps) {
  const [connectedServers, setConnectedServers] = useState<string[]>([]);
  const [availableTools, setAvailableTools] = useState<MCPTool[]>([]);

  useEffect(() => {
    const updateStatus = async () => {
      try {
        const manager = getMCPManager();
        const servers = manager.getServers();
        const tools = await manager.getTools();

        setConnectedServers(servers);
        setAvailableTools(tools);
      } catch (error) {
        // MCP manager not initialized yet
        setConnectedServers([]);
        setAvailableTools([]);
      }
    };

    // Initial update with a small delay to allow MCP initialization
    const initialTimer = setTimeout(updateStatus, 2000);

    // Listen for MCP server events instead of polling
    let manager;
    try {
      manager = getMCPManager();

      // Update on server add/remove events
      const handleServerChange = () => updateStatus();
      manager.on('serverAdded', handleServerChange);
      manager.on('serverRemoved', handleServerChange);
      manager.on('serverError', handleServerChange);

      // Cleanup listeners on unmount
      return () => {
        clearTimeout(initialTimer);
        if (manager) {
          manager.off('serverAdded', handleServerChange);
          manager.off('serverRemoved', handleServerChange);
          manager.off('serverError', handleServerChange);
        }
      };
    } catch (error) {
      // MCP not available, just cleanup timer
      return () => clearTimeout(initialTimer);
    }
  }, []);

  if (connectedServers.length === 0) {
    return null;
  }

  return (
    <Box marginLeft={1}>
      <Text color="green">⚒ mcps: {connectedServers.length} </Text>
    </Box>
  );
});
