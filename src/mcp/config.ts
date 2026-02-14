import { getSettingsManager } from "../utils/settings-manager.js";
import { MCPServerConfig } from "./client.js";

export interface MCPConfig {
  servers: MCPServerConfig[];
}

// Track whether we've already warned about missing env vars (one warning per session)
let hasWarnedAboutMissingEnvVars = false;

/**
 * Substitute environment variables in a string
 * Supports ${VAR_NAME} syntax
 * Returns both the substituted value and any undefined variable names found
 */
function substituteEnvVars(value: string): { value: string; undefinedVars: string[] } {
  const undefinedVars: string[] = [];
  const result = value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      undefinedVars.push(varName);
      return match;
    }
    return envValue;
  });
  return { value: result, undefinedVars };
}

/**
 * Recursively substitute environment variables in configuration objects
 * Returns {config: substituted config, hasUnresolved: true if any ${VAR} placeholders remain, undefinedVars: list of undefined variable names}
 */
function substituteEnvVarsInConfig(obj: any): { config: any; hasUnresolved: boolean; undefinedVars: string[] } {
  if (typeof obj === 'string') {
    const { value, undefinedVars } = substituteEnvVars(obj);
    return { config: value, hasUnresolved: value.includes('${'), undefinedVars };
  } else if (Array.isArray(obj)) {
    const results = obj.map(item => substituteEnvVarsInConfig(item));
    const allUndefinedVars = results.flatMap(r => r.undefinedVars);
    return {
      config: results.map(r => r.config),
      hasUnresolved: results.some(r => r.hasUnresolved),
      undefinedVars: [...new Set(allUndefinedVars)] // Deduplicate
    };
  } else if (obj !== null && typeof obj === 'object') {
    const result: any = {};
    let hasUnresolved = false;
    const allUndefinedVars: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
      const substituted = substituteEnvVarsInConfig(value);
      result[key] = substituted.config;
      if (substituted.hasUnresolved) {
        hasUnresolved = true;
      }
      allUndefinedVars.push(...substituted.undefinedVars);
    }
    return { config: result, hasUnresolved, undefinedVars: [...new Set(allUndefinedVars)] };
  }
  return { config: obj, hasUnresolved: false, undefinedVars: [] };
}

/**
 * Load MCP configuration from user settings (with project settings override)
 * Applies environment variable substitution to all string values
 */
export function loadMCPConfig(): MCPConfig {
  const manager = getSettingsManager();
  const userSettings = manager.loadUserSettings();
  const projectSettings = manager.loadProjectSettings();

  // Use project settings if available, otherwise fall back to user settings
  const mcpServers = projectSettings.mcpServers || userSettings.mcpServers;

  // Track servers with missing env vars for single consolidated warning
  const serversWithMissingVars: Array<{ name: string; vars: string[] }> = [];

  const servers = mcpServers
    ? Object.entries(mcpServers)
        .filter(([_, config]: [string, any]) => config.disabled !== true) // Filter out disabled servers
        .map(([name, config]: [string, any]) => {
          // Apply environment variable substitution to the entire config
          const substituted = substituteEnvVarsInConfig(config);

          // Track servers with unresolved vars for warning
          if (substituted.hasUnresolved && substituted.undefinedVars.length > 0) {
            serversWithMissingVars.push({ name, vars: substituted.undefinedVars });
          }

          return {
            name, // Ensure name field is set from the object key
            config: substituted.config,
            hasUnresolved: substituted.hasUnresolved
          };
        })
        .filter(item => !item.hasUnresolved) // Filter out servers with unresolved environment variables
        .map(item => ({
          name: item.name,
          transport: item.config.transport,
          command: item.config.command,
          args: item.config.args,
          env: item.config.env,
        }))
    : [];

  // Warn once per session about servers with missing env vars
  if (!hasWarnedAboutMissingEnvVars && serversWithMissingVars.length > 0) {
    hasWarnedAboutMissingEnvVars = true;
    console.warn(
      `Notice: ${serversWithMissingVars.length} MCP server(s) disabled due to missing environment variables:\n` +
      serversWithMissingVars.map(s => `  - ${s.name}: ${s.vars.join(', ')}`).join('\n')
    );
  }

  return { servers };
}

export function saveMCPConfig(config: MCPConfig): void {
  const manager = getSettingsManager();
  const mcpServers: Record<string, MCPServerConfig> = {};

  // Convert servers array to object keyed by name
  for (const server of config.servers) {
    mcpServers[server.name] = server;
  }

  manager.updateProjectSetting('mcpServers', mcpServers);
}

export function addMCPServer(config: MCPServerConfig): void {
  const manager = getSettingsManager();
  const projectSettings = manager.loadProjectSettings();
  const mcpServers = projectSettings.mcpServers || {};

  mcpServers[config.name] = config;
  manager.updateProjectSetting('mcpServers', mcpServers);
}

export function removeMCPServer(serverName: string): void {
  const manager = getSettingsManager();
  const projectSettings = manager.loadProjectSettings();
  const mcpServers = projectSettings.mcpServers;

  if (mcpServers) {
    delete mcpServers[serverName];
    manager.updateProjectSetting('mcpServers', mcpServers);
  }
}

export function getMCPServer(serverName: string): MCPServerConfig | undefined {
  const manager = getSettingsManager();
  const projectSettings = manager.loadProjectSettings();
  return projectSettings.mcpServers?.[serverName];
}

// Predefined server configurations
export const PREDEFINED_SERVERS: Record<string, MCPServerConfig> = {};
