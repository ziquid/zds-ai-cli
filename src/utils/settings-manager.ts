import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as yaml from "js-yaml";

/**
 * User-level settings stored in ~/.grok/user-settings.json
 * These are global settings that apply across all projects
 */
export interface UserSettings {
  apiKey?: string; // Grok API key
  baseURL?: string; // API base URL
  defaultModel?: string; // User's preferred default model
  models?: string[]; // Available models list
  temperature?: number; // Default temperature for API requests (0.0-2.0, default: 0.7)
  maxTokens?: number; // Default max tokens for API responses (no upper limit, default: undefined = API default)
  startupHook?: string; // Command to run at startup (new sessions only), output added to system prompt
  instanceHook?: string; // Command to run for every instance (new and resumed sessions), output parsed for commands
  postUserInputHook?: string; // Command to run after each user input is received
  preLLMResponseHook?: string; // Command to run before each prompt is sent to the LLM
  postLLMResponseHook?: string; // Command to run after each prompt is sent to the LLM
  preToolCallHook?: string; // Command to run before each approved tool call is executed
  postToolCallHook?: string; // Command to run after each approved tool call is executed
  taskApprovalHook?: string; // Command to validate task operations (start/transition/stop)
  toolApprovalHook?: string; // Command to validate tool execution before running
  personaHook?: string; // Command to validate persona changes
  personaHookMandatory?: boolean; // Whether persona hook is required
  moodHook?: string; // Command to validate mood changes
  moodHookMandatory?: boolean; // Whether mood hook is required
  contextViewHelper?: string; // Helper for viewing context in text mode (default: $PAGER or less)
  contextViewHelperGui?: string; // Helper for viewing context in GUI mode (default: open on macOS, xdg-open on Linux)
  contextEditHelper?: string; // Helper for editing context in text mode (default: $EDITOR or nano)
  contextEditHelperGui?: string; // Helper for editing context in GUI mode (default: open -e on macOS, xdg-open on Linux)
  mcpServers?: Record<string, any>; // MCP server configurations (fallback from user settings)
  mcpToolDenylist?: string[]; // List of MCP tool names to exclude from the LLM tool list
}

/**
 * Project-level settings stored in .grok/settings.json
 * These are project-specific settings
 */
export interface ProjectSettings {
  model?: string; // Current model for this project
  mcpServers?: Record<string, any>; // MCP server configurations
  mcpToolDenylist?: string[]; // List of MCP tool names to exclude from the LLM tool list
}

/**
 * Default values for user settings
 * Note: baseURL and defaultModel are typically set by environment variables or helpers
 */
const DEFAULT_USER_SETTINGS: Partial<UserSettings> = {
  baseURL: "https://api.x.ai/v1", // Grok default
  defaultModel: "grok-code-fast-1",
  models: ["grok-code-fast-1", "grok-4-1-latest", "grok-3-latest", "grok-3-fast", "grok-3-mini-fast",],
};

/**
 * Default values for project settings
 */
const DEFAULT_PROJECT_SETTINGS: Partial<ProjectSettings> = {
  model: "grok-code-fast-1",
};

/**
 * Unified settings manager that handles both user-level and project-level settings
 */
export class SettingsManager {
  private static instance: SettingsManager;
  private static customUserSettingsPath: string | null = null;

  private userSettingsPath: string;
  private userMcpServersPath: string;
  private userVarsPath: string;
  private projectSettingsPath: string;
  private projectMcpServersPath: string;

  /**
   * Set a custom user settings file path (must be called before getInstance)
   */
  static setCustomUserSettingsPath(filePath: string): void {
    SettingsManager.customUserSettingsPath = filePath;
  }

  private constructor() {
    // User settings path: custom or ~/.zds-ai/cli-settings.json
    this.userSettingsPath = SettingsManager.customUserSettingsPath || path.join(os.homedir(), ".zds-ai", "cli-settings.json");

    // Derive config home from the settings file's directory, not os.homedir().
    // When invoked with -s /agent-home/.zds-ai/cli-settings.json (e.g. by sociobot
    // running as a different user), HOME points to the wrong user.  The settings
    // file path is the authoritative source for where mcp.json and cli-vars.yml live.
    const configHomeDir = path.dirname(this.userSettingsPath);

    // User mcp servers path: <config-home>/mcp.json
    this.userMcpServersPath = path.join(configHomeDir, "mcp.json");

    // User variable definitions path: <config-home>/cli-vars.yml
    this.userVarsPath = path.join(configHomeDir, "cli-vars.yml");

    // Project settings path: .zds-ai/project-settings.json (in current working directory)
    this.projectSettingsPath = path.join(process.cwd(), ".zds-ai", "project-settings.json");

    // Project mcp servers path: .zds-ai/project-mcp.json (in current working directory)
    this.projectMcpServersPath = path.join(process.cwd(), ".zds-ai", "project-mcp.json");
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): SettingsManager {
    if (!SettingsManager.instance) {
      SettingsManager.instance = new SettingsManager();
    }
    return SettingsManager.instance;
  }

  /**
   * Load user settings from appropriate files
   */
  public loadUserSettings(): UserSettings {
    try {
      if (!fs.existsSync(this.userSettingsPath)) {
        // Create default user settings if file doesn't exist
        this.saveUserSettings(DEFAULT_USER_SETTINGS);
        return {...DEFAULT_USER_SETTINGS};
      }

      const content = fs.readFileSync(this.userSettingsPath, "utf-8");
      const settings = JSON.parse(content);

      // Load and merge mcpServers from separate files
      let userMcpServers: Record<string, any> = {};
      let projectMcpServers: Record<string, any> = {};

      // Load user MCP servers
      if (fs.existsSync(this.userMcpServersPath)) {
        try {
          const mcpContent = fs.readFileSync(this.userMcpServersPath, "utf-8");
          const mcpConfig = JSON.parse(mcpContent);
          userMcpServers = mcpConfig.mcpServers || {};
        } catch (error) {
          console.warn(`Failed to load user MCP config from ${this.userMcpServersPath}:`, error instanceof Error ? error.message : "Unknown error");
        }
      }

      // Load project MCP servers
      if (fs.existsSync(this.projectMcpServersPath)) {
        try {
          const mcpContent = fs.readFileSync(this.projectMcpServersPath, "utf-8");
          const mcpConfig = JSON.parse(mcpContent);
          projectMcpServers = mcpConfig.mcpServers || {};
        } catch (error) {
          console.warn(`Failed to load project MCP config from ${this.projectMcpServersPath}:`, error instanceof Error ? error.message : "Unknown error");
        }
      }

      // Merge user and project MCP servers, with project overriding user
      settings.mcpServers = {...userMcpServers, ...projectMcpServers};

      // Merge with defaults to ensure all required fields exist
      return {...DEFAULT_USER_SETTINGS, ...settings};
    } catch (error) {
      console.warn("Failed to load user settings:", error instanceof Error ? error.message : "Unknown error");
      return {...DEFAULT_USER_SETTINGS};
    }
  }

  /**
   * Save user settings to ~/.grok/user-settings.json
   * mcpServers is saved to ~/.zds-ai/mcp.json separately
   */
  public saveUserSettings(settings: Partial<UserSettings>): void {
    try {
      this.ensureDirectoryExists(this.userSettingsPath);

      // Read existing settings directly to avoid recursion
      let existingSettings: UserSettings = {...DEFAULT_USER_SETTINGS};
      if (fs.existsSync(this.userSettingsPath)) {
        try {
          const content = fs.readFileSync(this.userSettingsPath, "utf-8");
          const parsed = JSON.parse(content);
          existingSettings = {...DEFAULT_USER_SETTINGS, ...parsed};
        } catch (error) {
          // If file is corrupted, use defaults
          console.warn("Corrupted user settings file, using defaults");
        }
      }

      const mergedSettings = {...existingSettings, ...settings};

      // Extract mcpServers and save separately
      if (mergedSettings.mcpServers !== undefined) {
        const mcpServers = mergedSettings.mcpServers;

        // Save MCP servers to separate file
        this.ensureDirectoryExists(this.userMcpServersPath);
        const mcpConfig = { mcpServers };
        fs.writeFileSync(this.userMcpServersPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
      }

      // Remove mcpServers from settings before saving to main file
      const settingsToSave = {...mergedSettings};
      delete settingsToSave.mcpServers;

      fs.writeFileSync(this.userSettingsPath, JSON.stringify(settingsToSave, null, 2), {mode: 0o600} // Secure permissions for API key
      );
    } catch (error) {
      console.error("Failed to save user settings:", error instanceof Error ? error.message : "Unknown error");
      throw error;
    }
  }

  /**
   * Update a specific user setting
   */
  public updateUserSetting<K extends keyof UserSettings>(key: K, value: UserSettings[K]): void {
    const settings = {[key]: value} as Partial<UserSettings>;
    this.saveUserSettings(settings);
  }

  /**
   * Get a specific user setting
   */
  public getUserSetting<K extends keyof UserSettings>(key: K): UserSettings[K] {
    const settings = this.loadUserSettings();
    return settings[key];
  }

  /**
   * Load project settings from .zds-ai/project-settings.json
   * mcpServers is loaded from .zds-ai/project-mcp.json if it exists
   */
  public loadProjectSettings(): ProjectSettings {
    try {
      let settings: ProjectSettings = {...DEFAULT_PROJECT_SETTINGS};

      // Load main project settings
      if (fs.existsSync(this.projectSettingsPath)) {
        const content = fs.readFileSync(this.projectSettingsPath, "utf-8");
        if (content.trim()) {
          const parsed = JSON.parse(content);
          settings = {...DEFAULT_PROJECT_SETTINGS, ...parsed};
        }
      }

      // Load project MCP servers from separate file
      if (fs.existsSync(this.projectMcpServersPath)) {
        try {
          const mcpContent = fs.readFileSync(this.projectMcpServersPath, "utf-8");
          const mcpConfig = JSON.parse(mcpContent);
          settings.mcpServers = mcpConfig.mcpServers || {};
        } catch (error) {
          console.warn(`Failed to load project MCP config from ${this.projectMcpServersPath}:`, error instanceof Error ? error.message : "Unknown error");
        }
      }

      return settings;
    } catch (error) {
      console.warn("Failed to load project settings:", error instanceof Error ? error.message : "Unknown error");
      return {...DEFAULT_PROJECT_SETTINGS};
    }
  }

  /**
   * Save project settings to .zds-ai/project-settings.json
   * mcpServers is saved to .zds-ai/project-mcp.json separately
   */
  public saveProjectSettings(settings: Partial<ProjectSettings>): void {
    try {
      this.ensureDirectoryExists(this.projectSettingsPath);

      // Read existing settings
      let existingSettings: ProjectSettings = {...DEFAULT_PROJECT_SETTINGS};
      if (fs.existsSync(this.projectSettingsPath)) {
        try {
          const content = fs.readFileSync(this.projectSettingsPath, "utf-8");
          if (content.trim()) {
            const parsed = JSON.parse(content);
            existingSettings = {...DEFAULT_PROJECT_SETTINGS, ...parsed};
          }
        } catch (error) {
          console.warn("Corrupted project settings file, using defaults");
        }
      }

      const mergedSettings = {...existingSettings, ...settings};

      // Extract mcpServers and save separately
      if (mergedSettings.mcpServers !== undefined) {
        const mcpServers = mergedSettings.mcpServers;

        // Save MCP servers to separate file
        this.ensureDirectoryExists(this.projectMcpServersPath);
        const mcpConfig = { mcpServers };
        fs.writeFileSync(this.projectMcpServersPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
      }

      // Remove mcpServers from settings before saving to main file
      const settingsToSave = {...mergedSettings};
      delete settingsToSave.mcpServers;

      fs.writeFileSync(this.projectSettingsPath, JSON.stringify(settingsToSave, null, 2), { mode: 0o600 });
    } catch (error) {
      console.error("Failed to save project settings:", error instanceof Error ? error.message : "Unknown error");
      throw error;
    }
  }

  /**
   * Update a specific project setting
   */
  public updateProjectSetting<K extends keyof ProjectSettings>(key: K, value: ProjectSettings[K]): void {
    const settings = {[key]: value} as Partial<ProjectSettings>;
    this.saveProjectSettings(settings);
  }

  /**
   * Get a specific project setting
   */
  public getProjectSetting<K extends keyof ProjectSettings>(key: K): ProjectSettings[K] {
    const settings = this.loadProjectSettings();
    return settings[key];
  }

  /**
   * Get the current model with proper fallback logic:
   * 1. Project-specific model setting
   * 2. User's default model
   * 3. System default
   */
  public getCurrentModel(): string {
    const projectModel = this.getProjectSetting("model");
    if (projectModel) {
      return projectModel;
    }

    const userDefaultModel = this.getUserSetting("defaultModel");
    if (userDefaultModel) {
      return userDefaultModel;
    }

    return DEFAULT_PROJECT_SETTINGS.model || "grok-code-fast-1";
  }

  /**
   * Set the current model for the project
   */
  public setCurrentModel(model: string): void {
    this.updateProjectSetting("model", model);
  }

  /**
   * Get available models list from user settings
   */
  public getAvailableModels(): string[] {
    const models = this.getUserSetting("models");
    return models || DEFAULT_USER_SETTINGS.models || [];
  }

  /**
   * Get API key from user settings or environment
   */
  public getApiKey(): string | undefined {
    // First check environment variable
    const envApiKey = process.env.GROK_API_KEY;
    if (envApiKey) {
      return envApiKey;
    }

    // Then check user settings
    return this.getUserSetting("apiKey");
  }

  /**
   * Get startup hook command from user settings
   */
  public getStartupHook(): string | undefined {
    return this.getUserSetting("startupHook");
  }

  /**
   * Get instance hook command from user settings
   */
  public getInstanceHook(): string | undefined {
    return this.getUserSetting("instanceHook");
  }

  /**
   * Get task approval hook command from user settings
   * Used for validating all task operations (start/transition/stop)
   */
  public getTaskApprovalHook(): string | undefined {
    return this.getUserSetting("taskApprovalHook");
  }

  /**
   * Get tool approval hook command from user settings
   */
  public getToolApprovalHook(): string | undefined {
    return this.getUserSetting("toolApprovalHook");
  }

  /**
   * Get persona hook command from user settings
   */
  public getPersonaHook(): string | undefined {
    return this.getUserSetting("personaHook");
  }

  /**
   * Check if persona hook is mandatory
   */
  public isPersonaHookMandatory(): boolean {
    return this.getUserSetting("personaHookMandatory") ?? false;
  }

  /**
   * Get mood hook command from user settings
   */
  public getMoodHook(): string | undefined {
    return this.getUserSetting("moodHook");
  }

  /**
   * Check if mood hook is mandatory
   */
  public isMoodHookMandatory(): boolean {
    return this.getUserSetting("moodHookMandatory") ?? false;
  }

  /**
   * Get postUserInput hook command from user settings
   */
  public getPostUserInputHook(): string | undefined {
    return this.getUserSetting("postUserInputHook");
  }

  /**
   * Get preLLMResponse hook command from user settings
   */
  public getPreLLMResponseHook(): string | undefined {
    return this.getUserSetting("preLLMResponseHook");
  }

  /**
   * Get postLLMResponse hook command from user settings
   */
  public getPostLLMResponseHook(): string | undefined {
    return this.getUserSetting("postLLMResponseHook");
  }

  /**
   * Get preToolCall hook command from user settings
   */
  public getPreToolCallHook(): string | undefined {
    return this.getUserSetting("preToolCallHook");
  }

  /**
   * Get postToolCall hook command from user settings
   */
  public getPostToolCallHook(): string | undefined {
    return this.getUserSetting("postToolCallHook");
  }

  /**
   * Detect if we're running in a GUI environment or text-only (SSH/terminal)
   * Returns true if GUI is available, false for text-only
   */
  public isGuiAvailable(): boolean {
    // Check if SSH session
    if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY) {
      return false;
    }

    // Check platform-specific GUI indicators
    if (process.platform === "darwin") {
      // macOS: Check if we have GUI session (not ssh, not screen/tmux)
      return !process.env.STY && !process.env.TMUX;
    } else if (process.platform === "linux") {
      // Linux: Check for X11 or Wayland display
      return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
    } else if (process.platform === "win32") {
      // Windows: Assume GUI available unless in WSL SSH
      return true;
    }

    // Default to text-only if uncertain
    return false;
  }

  /**
   * Get context view helper command from user settings
   * Auto-detects GUI vs text-only environment
   */
  public getContextViewHelper(): string {
    const isGui = this.isGuiAvailable();

    if (isGui) {
      // GUI mode
      const guiHelper = this.getUserSetting("contextViewHelperGui");
      if (guiHelper) {
        return guiHelper;
      }

      // Platform-specific GUI defaults
      if (process.platform === "darwin") {
        return "open"; // macOS: open in default app
      } else if (process.platform === "linux") {
        return "xdg-open"; // Linux: open in default app
      } else if (process.platform === "win32") {
        return "start"; // Windows: open in default app
      }
    }

    // Text mode
    const textHelper = this.getUserSetting("contextViewHelper");
    if (textHelper) {
      return textHelper;
    }

    // Fall back to environment variable
    const pager = process.env.PAGER;
    if (pager) {
      return pager;
    }

    // Fall back to common pagers
    return "less -R"; // -R for color support
  }

  /**
   * Get context edit helper command from user settings
   * Auto-detects GUI vs text-only environment
   */
  public getContextEditHelper(): string {
    const isGui = this.isGuiAvailable();

    if (isGui) {
      // GUI mode
      const guiHelper = this.getUserSetting("contextEditHelperGui");
      if (guiHelper) {
        return guiHelper;
      }

      // Platform-specific GUI defaults
      if (process.platform === "darwin") {
        return "open -e"; // macOS: open in TextEdit
      } else if (process.platform === "linux") {
        return "xdg-open"; // Linux: open in default editor
      } else if (process.platform === "win32") {
        return "notepad"; // Windows: Notepad
      }
    }

    // Text mode
    const textHelper = this.getUserSetting("contextEditHelper");
    if (textHelper) {
      return textHelper;
    }

    // Fall back to environment variables
    const editor = process.env.EDITOR || process.env.VISUAL;
    if (editor) {
      return editor;
    }

    // Fall back to common editors
    return "nano";
  }

  /**
   * Get base URL from user settings or environment
   */
  public getBaseURL(): string {
    // First check environment variable
    const envBaseURL = process.env.GROK_BASE_URL;
    if (envBaseURL) {
      return envBaseURL;
    }

    // Then check user settings, then use default
    const userBaseURL = this.getUserSetting("baseURL");
    return userBaseURL || DEFAULT_USER_SETTINGS.baseURL || "https://api.x.ai/v1";
  }

  /**
   * Get temperature from user settings
   * Defaults to 0.7 if not set
   */
  public getTemperature(): number {
    const temperature = this.getUserSetting("temperature");
    if (temperature !== undefined && temperature >= 0 && temperature <= 2) {
      return temperature;
    }
    return 0.7; // Default temperature
  }

  /**
   * Get max tokens from user settings or environment
   * Priority: user settings > ZDS_AI_AGENT_MAX_TOKENS env var > undefined
   * Returns undefined if not set (allows API to use its default)
   */
  public getMaxTokens(): number | undefined {
    // First check user settings
    const settingsMaxTokens = this.getUserSetting("maxTokens");
    if (settingsMaxTokens !== undefined && Number.isInteger(settingsMaxTokens) && settingsMaxTokens > 0) {
      return settingsMaxTokens;
    }

    // Then check environment variable (set by hooks)
    const envMaxTokens = process.env.ZDS_AI_AGENT_MAX_TOKENS;
    if (envMaxTokens) {
      const parsed = parseInt(envMaxTokens);
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return undefined; // No default - let API decide
  }

  public loadVariableDefinitions(): any[] {
    try {
      if (!fs.existsSync(this.userVarsPath)) return [];

      const fileContents = fs.readFileSync(this.userVarsPath, 'utf8');
      const data = yaml.load(fileContents) as { variables: any[] };

      if (!data || !Array.isArray(data.variables)) {
        console.error(`Invalid cli-vars.yml format in ${this.userVarsPath}: expected { variables: [...] }`);
        return [];
      }

      return data.variables;
    } catch (error) {
      console.error(`Error loading ${this.userVarsPath}: ${error}`);
      return [];
    }
  }

  /**
   * Ensure directory exists for a given file path
   */
  private ensureDirectoryExists(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    }
  }
}

/**
 * Convenience function to get the singleton instance
 */
export function getSettingsManager(): SettingsManager {
  return SettingsManager.getInstance();
}
