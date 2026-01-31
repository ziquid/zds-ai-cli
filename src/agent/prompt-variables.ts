import { SettingsManager } from '../utils/settings-manager.js';

/**
 * Variable definition class for prompt template system
 * Defines structure, behavior, and relationships between variables
 */
export class VariableDef {
  /**
   * Map of variable names to their definitions
   * Indexed by variable name (e.g., "USER:PRE" -> VariableDef)
   */
  private static definitions: Map<string, VariableDef> = new Map();

  /** Variable name (e.g., "USER:PRE", "SYSTEM") */
  name: string;
  /** Rendering weight for ordering (lower = earlier) */
  weight: number = 52;
  /** Environment variable to read value from */
  env_var?: string;
  /** Whether to render in full template expansion */
  renderFull: boolean = true;
  /** Whether variable persists across clearOneShot() calls */
  persists: boolean = false;
  /** Template string with %VAR% placeholders and %% for own content */
  template: string = "%%";
  /** Variables referenced in template (%VAR% patterns) */
  adoptedChildren: string[] = [];
  /** Function to dynamically compute variable value */
  getter?: () => string;

  constructor(config: {
    name: string;
    weight?: number;
    env_var?: string;
    renderFull?: boolean;
    persists?: boolean;
    template?: string;
    getter?: () => string;
  }) {
    Object.assign(this, config);

    // Parse template for %VAR% references (adopted children)
    if (this.template) {
      const regex = /%([A-Z_:]+)%/g;
      let match;
      while ((match = regex.exec(this.template)) !== null) {
        const varName = match[1];
        if (varName !== "" && !this.adoptedChildren.includes(varName)) {
          this.adoptedChildren.push(varName);
        }
      }
    }
  }

  /**
   * Get or create definition by name
   * Looks in definitions map, then PROMPT_VARS, then creates default
   * 
   * @param name Variable name
   * @returns VariableDef instance
   */
  static getOrCreate(name: string): VariableDef {
    // Check if definition already exists in map
    let def = VariableDef.definitions.get(name);
    if (def) return def;

    // Try to find in PROMPT_VARS template
    const predefined = PROMPT_VARS.find(v => v.name === name);
    if (predefined) {
      VariableDef.definitions.set(name, predefined);
      return predefined;
    }

    // Create default definition and add to map
    def = new VariableDef({ name });
    VariableDef.definitions.set(name, def);
    return def;
  }

  /**
   * Get all variable definitions
   * Ensures all PROMPT_VARS are loaded into definitions map
   * Later definitions override earlier ones (YAML overrides hardcoded)
   *
   * @returns Array of all VariableDef instances
   */
  static getAllDefinitions(): VariableDef[] {
    // Load all PROMPT_VARS into definitions (later entries override earlier)
    for (const promptVar of PROMPT_VARS) {
      VariableDef.definitions.set(promptVar.name, promptVar);
    }

    return Array.from(VariableDef.definitions.values());
  }

  /**
   * Check if a variable is intrinsic (hardcoded in TypeScript)
   *
   * @param name Variable name
   * @returns True if defined in INTRINSIC_VARS
   */
  static isIntrinsic(name: string): boolean {
    return INTRINSIC_VARS.some(v => v.name === name);
  }

  /**
   * Check if a variable is explicit (defined in external YAML file)
   *
   * @param name Variable name
   * @returns True if defined in EXTERNAL_VARS
   */
  static isExplicit(name: string): boolean {
    return EXTERNAL_VARS.some(v => v.name === name);
  }
}

/**
 * Variable instance class for prompt template system
 * Holds actual values and handles rendering logic
 * 
 * Supports:
 * - Hierarchical variable relationships (parent:child)
 * - Template expansion with %VAR% placeholders
 * - Dynamic value computation via getters
 * - Circular dependency detection
 * - Weight-based ordering
 */
export class Variable {
  /**
   * Map of variable names to their current values
   * Indexed by variable name (e.g., "USER:PRE" -> Variable)
   */
  private static variables: Map<string, Variable> = new Map();

  /** Variable definition (structure and behavior) */
  def: VariableDef;
  /** Array of string values for this variable */
  values: string[] = [];
  /** Whether variable has new/changed values since last render */
  isNew: boolean = false;

  constructor(name: string) {
    this.def = VariableDef.getOrCreate(name);
  }

  get name(): string {
    return this.def.name;
  }

  get weight(): number {
    return this.def.weight;
  }

  get template(): string {
    return this.def.template;
  }

  get renderFull(): boolean {
    return this.def.renderFull;
  }

  get persists(): boolean {
    return this.def.persists;
  }

  /**
   * Set variable value (replaces existing values)
   * Creates variable if it doesn't exist
   *
   * @param name Variable name
   * @param value Value to set
   */
  static set(name: string, value: string): void {
    const variable = Variable.getOrCreate(name);
    variable.values = [value];
    variable.isNew = true;
  }

  /**
   * Append value to variable (adds to existing values)
   * Creates variable if it doesn't exist
   * Use when building multi-value variables within same execution context
   *
   * @param name Variable name
   * @param value Value to append
   */
  static append(name: string, value: string): void {
    const variable = Variable.getOrCreate(name);
    variable.values.push(value);
    variable.isNew = true;
  }

  /**
   * Get variable by name
   *
   * @param name Variable name
   * @returns Variable instance or undefined
   */
  static get(name: string): Variable | undefined {
    return Variable.variables.get(name);
  }

  /**
   * Get or create variable by name
   *
   * @param name Variable name
   * @returns Variable instance
   */
  static getOrCreate(name: string): Variable {
    let variable = Variable.variables.get(name);
    if (!variable) {
      variable = new Variable(name);
      Variable.variables.set(name, variable);
    }
    return variable;
  }

  /**
   * Get all set variables
   * 
   * @returns Array of all Variable instances
   */
  static getAllVariables(): Variable[] {
    return Array.from(Variable.variables.values());
  }

  /**
   * Clear all one-shot variables
   * Removes variables where persists=false
   */
  static clearOneShot(): void {
    for (const [name, variable] of Variable.variables.entries()) {
      if (!variable.persists) {
        Variable.variables.delete(name);
      }
    }
  }

  /**
   * Export persistent variables for saving to context.json
   * Returns only variables with persists=true
   *
   * @returns Object with variable names as keys and objects containing values and isNew state
   */
  static exportPersistentVariables(): Record<string, { values: string[]; isNew: boolean }> {
    const persistent: Record<string, { values: string[]; isNew: boolean }> = {};

    for (const [name, variable] of Variable.variables.entries()) {
      if (variable.persists && variable.values.length > 0) {
        persistent[name] = {
          values: [...variable.values],
          isNew: variable.isNew
        };
      }
    }

    return persistent;
  }

  /**
   * Import persistent variables from saved context.json
   * Restores variables with their values and isNew state
   *
   * @param saved Object with variable names as keys and objects containing values and isNew state
   */
  static importPersistentVariables(saved: Record<string, { values: string[]; isNew: boolean }>): void {
    for (const [name, data] of Object.entries(saved)) {
      if (data.values.length > 0) {
        const variable = Variable.getOrCreate(name);
        variable.values = [...data.values];
        variable.isNew = data.isNew;
      }
    }
  }

  /**
   * Find birth child variables of given parent
   * Returns variables with prefix "parent:" sorted by weight
   *
   * @param parent Parent name (e.g., "USER" or "SYSTEM")
   * @returns Variables with prefix "parent:", renderFull=true, sorted by weight
   */
  static findBirthChildren(parent: string): Variable[] {
    const prefix = `${parent}:`;
    const found: Variable[] = [];
    const foundNames = new Set<string>();

    // First check existing variables
    for (const variable of Variable.variables.values()) {
      if (variable.name.startsWith(prefix) && variable.renderFull) {
        // Only include immediate children (no additional colons after prefix)
        const remainder = variable.name.substring(prefix.length);
        if (!remainder.includes(':')) {
          found.push(variable);
          foundNames.add(variable.name);
        }
      }
    }

    // Also check definitions and create variables for any we haven't found yet
    const allDefs = VariableDef.getAllDefinitions();
    for (const def of allDefs) {
      if (def.name.startsWith(prefix) && def.name !== parent && def.renderFull) {
        // Only include immediate children (no additional colons after prefix)
        const remainder = def.name.substring(prefix.length);
        if (!remainder.includes(':')) {
          // Create the variable if it doesn't exist
          if (!foundNames.has(def.name)) {
            let variable = Variable.get(def.name);
            if (!variable) {
              variable = new Variable(def.name);
              Variable.variables.set(def.name, variable);
            }
            found.push(variable);
            foundNames.add(def.name);
          }
        }
      }
    }

    // Also check for "orphaned grandchildren" - variables like MESSAGE:ACL:CURRENT
    // where the intermediate parent (MESSAGE:ACL) doesn't exist yet
    for (const variable of Variable.variables.values()) {
      if (variable.name.startsWith(prefix) && variable.renderFull) {
        const remainder = variable.name.substring(prefix.length);
        // If this is a grandchild (has colon in remainder)
        if (remainder.includes(':')) {
          // Extract the intermediate parent name (e.g., MESSAGE:ACL from MESSAGE:ACL:CURRENT)
          const intermediateName = `${parent}:${remainder.split(':')[0]}`;
          // If we haven't found this intermediate parent yet, create it
          if (!foundNames.has(intermediateName)) {
            let intermediateVar = Variable.get(intermediateName);
            if (!intermediateVar) {
              intermediateVar = new Variable(intermediateName);
              Variable.variables.set(intermediateName, intermediateVar);
            }
            found.push(intermediateVar);
            foundNames.add(intermediateName);
          }
        }
      }
    }

    // Sort by weight (primary), then name alphabetically (secondary)
    found.sort((a, b) => {
      if (a.weight !== b.weight) {
        return a.weight - b.weight;
      }
      return a.name.localeCompare(b.name);
    });

    return found;
  }

  /**
   * Find all child variables of given parent
   * Returns both birth children (prefix match) and adopted children (template refs)
   *
   * @param parent Parent name (e.g., "USER")
   * @returns All child variables with renderFull=true, sorted by weight
   */
  static findFullChildrenVars(parent: string): Variable[] {
    const found: Variable[] = [];

    // Find birth children (prefix match)
    found.push(...Variable.findBirthChildren(parent));

    // Find adopted children (from parent's template)
    const parentDef = VariableDef.getOrCreate(parent);
    for (const adoptedName of parentDef.adoptedChildren) {
      const adoptedVar = Variable.get(adoptedName);
      if (adoptedVar && adoptedVar.renderFull && !found.includes(adoptedVar)) {
        found.push(adoptedVar);
      }
    }

    // Sort by weight (primary), then name alphabetically (secondary)
    found.sort((a, b) => {
      if (a.weight !== b.weight) {
        return a.weight - b.weight;
      }
      return a.name.localeCompare(b.name);
    });

    return found;
  }

  /**
   * Render a variable fully with recursive template expansion
   * Handles variable creation, getter execution, and circular dependency detection
   * 
   * @param name Variable name (e.g., "USER" or "USER:PROMPT")
   * @param renderingStack Set of variables currently being rendered (for cycle detection)
   * @returns Rendered string
   */
  static renderFull(name: string, renderingStack: Set<string> = new Set()): string {
    // Check for circular dependency
    if (renderingStack.has(name)) {
      const parent = Array.from(renderingStack).pop() || "unknown";
      return `ERROR: ${name} already rendered, refusing to render as child of ${parent}`;
    }

    // Add to stack
    renderingStack.add(name);

    let variable = Variable.get(name);
    let result = "";

    // If variable doesn't exist but definition has getter, auto-create it
    if (!variable) {
      const def = VariableDef.getOrCreate(name);
      if (def.getter) {
        variable = new Variable(name);
        Variable.variables.set(name, variable);
      }
    }

    if (variable) {
      // Variable exists - render its template
      result = variable.renderFullTemplate(renderingStack);
    } else {
      // Variable doesn't exist - check if it has children or getter
      const def = VariableDef.getOrCreate(name);
      const children = Variable.findFullChildrenVars(name);

      if (children.length > 0 || def.getter) {
        // Create the variable instance so it can render properly
        variable = new Variable(name);
        Variable.variables.set(name, variable);
        result = variable.renderFullTemplate(renderingStack);
      }
    }

    // Remove from stack
    renderingStack.delete(name);

    return result;
  }

  /**
   * Render variable using its template with placeholder substitution
   * Handles %VAR% substitution and %% replacement with own values + children
   * 
   * @param renderingStack Set of variables currently being rendered (for cycle detection)
   * @returns Rendered template string
   */
  renderFullTemplate(renderingStack: Set<string> = new Set()): string {
    let rendered = this.template;
    const isDefaultTemplate = this.template === "%%";

    // First, substitute %VAR% patterns (adopted children)
    rendered = rendered.replace(/%([A-Z_:]+)%/g, (match, varName) => {
      if (varName === "") return match;
      return Variable.renderFull(varName, renderingStack);
    });

    // Then, substitute %% with own values + birth children
    const birthChildren = Variable.findBirthChildren(this.name);

    // Render children, wrapping those with default templates
    const birthRendered = birthChildren.map(child => {
      const childContent = Variable.renderFull(child.name, renderingStack);

      // If child has default template, wrap it in child's tag
      if (child.def.template === "%%") {
        // Only create wrapper tags if child has rendered content
        if (childContent.trim()) {
          // Use last segment of child's name for tag (e.g., SESSION:FRONTEND → frontend)
          const parts = child.name.split(':');
          const tagName = parts[parts.length - 1].toLowerCase();
          return `<${tagName}>${childContent}</${tagName}>\n`;
        }
        return ""; // No content, no wrapper
      } else {
        // Child has custom template -- it handles its own wrapping
        return childContent;
      }
    }).join("");

    const ownValues = this.renderFullValue();

    // If no content (no values and no children) AND no adopted children,
    // return empty instead of rendering template.
    // Variables with adopted children (like SYSTEM) should always render
    // because they provide structure, not just wrapping.
    if (this.def.adoptedChildren.length === 0 &&
        ownValues.trim().length === 0 &&
        birthRendered.trim().length === 0) {
      return "";
    }

    rendered = rendered.replace("%%", ownValues + birthRendered);

    return rendered;
  }

  /**
   * Render variable values as string with dynamic getter support
   * Updates values from getter if present and value changed
   * Clears isNew flag after rendering
   * 
   * @param separator String to join multiple values (default: "\n")
   * @returns Joined values string
   */
  renderFullValue(separator: string = "\n"): string {
    // If this variable has a getter, update value dynamically
    if (this.def.getter) {
      const newValue = this.def.getter();
      const oldValue = this.values[0];

      // Only update if value changed
      if (oldValue !== newValue) {
        this.values = [newValue];
        this.isNew = true;
      }
    }

    const result = this.values.join(separator);

    // Clear isNew flag after rendering (variable has been consumed)
    this.isNew = false;

    return result;
  }
}

/**
 * Intrinsic (hardcoded) variable definitions
 * These cannot be externalized and provide fallback defaults
 */
const INTRINSIC_VARS: VariableDef[] = [
  new VariableDef({
    name: "SYSTEM",
    template: "You are a helpful AI assistant.\n\n%APP%"
  }),
  new VariableDef({
    name: "APP:CWD",
    weight: 80,
    getter: () => process.cwd()
  }),
  new VariableDef({
    name: "APP:TOOLS",
    weight: 70,
    persists: true
  }),
  new VariableDef({
    name: "APP:TIMESTAMP:UTC",
    weight: 81,
    getter: () => new Date().toISOString()
  }),
  new VariableDef({
    name: "APP:TIMESTAMP:LOCALIZED",
    weight: 82,
    getter: () => new Date().toLocaleString()
  }),
  new VariableDef({
    name: "USER:PROMPT",
    weight: 50
  }),
];

/**
 * Load variable definitions from ~/.zds-ai/cli-vars.yml via SettingsManager
 * Returns array of VariableDef instances
 */
function loadVariableDefinitions(): VariableDef[] {
  const settingsManager = SettingsManager.getInstance();
  const varDefs = settingsManager.loadVariableDefinitions();
  return varDefs.map(varDef => new VariableDef(varDef));
}

/**
 * External (YAML) variable definitions
 * Loaded from ~/.zds-ai/cli-vars.yml
 */
const EXTERNAL_VARS: VariableDef[] = loadVariableDefinitions();

/**
 * Predefined variable definitions for the prompt system
 * Intrinsic definitions provide defaults, external definitions override
 */
const PROMPT_VARS: VariableDef[] = [
  ...INTRINSIC_VARS,
  ...EXTERNAL_VARS,
];
