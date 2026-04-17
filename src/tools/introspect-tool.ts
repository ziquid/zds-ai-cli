import { ToolResult } from "../types/index.js";
import { ToolDiscovery, getHandledToolNames } from "./tool-discovery.js";
import { getAllLLMTools } from "../grok/tools.js";
import { BUILT_IN_COMMANDS } from "../utils/slash-commands.js";
import { Variable, VariableDef } from "../agent/prompt-variables.js";
import chalk from "chalk";

export class IntrospectTool implements ToolDiscovery {
  private agent: any; // Reference to the LLMAgent for accessing tool class info

  setAgent(agent: any) {
    this.agent = agent;
  }

  /**
   * Introspect available tools and system information
   */
  async introspect(target: string): Promise<ToolResult> {
    try {
      if (!target || target === "help") {
        return {
          success: true,
          output: `/introspect - Introspect available tools and environment

Usage:
  /introspect tools             - Show all available tools (internal and MCP)
  /introspect tool:TOOL_NAME    - Show schema for specific tool
  /introspect commands          - Show available slash commands
  /introspect env               - Show ZDS_AI_AGENT_* environment variables
  /introspect context           - Show context/token usage
  /introspect vars              - Show all set prompt variables
  /introspect var:VAR_NAME      - Show details for specific variable
  /introspect render:VAR_NAME   - Show rendered value of specific variable
  /introspect defs              - Show all variable definitions
  /introspect def:VAR_NAME      - Show variable definition with birth children tree
  /introspect all               - Show tools, environment variables, and context

Examples:
  # Discover what MCP tools are available
  introspect("tools")

  # Learn how to use a specific MCP tool (shows parameters, types, descriptions)
  introspect("tool:mcp__tavily__tavily-search")

  # Look up an internal tool's parameters
  introspect("tool:viewFile")

  # See available slash commands
  introspect("commands")

  # Check context/token usage
  introspect("context")

  # Show all set prompt variables
  introspect("vars")

  # Show details for a specific variable
  introspect("var:CHAR:MOOD")

  # Show rendered value of a specific variable
  introspect("render:SYSTEM")

  # Show all variable definitions
  introspect("defs")

  # Show variable definition with birth children tree structure
  introspect("def:SYSTEM")

Workflow for using unknown MCP tools:
  1. Call introspect("tools") to see all available tools
  2. Find the MCP tool you need (e.g., mcp__tavily__tavily-search)
  3. Call introspect("tool:mcp__tavily__tavily-search") to see its parameters
  4. Use the tool with the parameters you learned about`,
          displayOutput: "Introspect help"
        };
      }

      // Handle tool:TOOL_NAME format for specific tool schema lookup
      if (target.startsWith("tool:")) {
        const toolName = target.substring(5); // Remove "tool:" prefix
        const allTools = await getAllLLMTools();
        const tool = allTools.find(t => t.function.name === toolName);

        if (!tool) {
          return {
            success: false,
            error: `Tool not found: ${toolName}`
          };
        }

        // Format the tool schema in a readable way
        let output = `Tool: ${tool.function.name}\n`;
        output += `Description: ${tool.function.description}\n\n`;
        output += `Parameters:\n`;

        const params = tool.function.parameters;
        if (params && params.properties) {
          const required = params.required || [];
          const properties = params.properties;

          Object.keys(properties).sort().forEach(paramName => {
            const param = properties[paramName];
            const isRequired = required.includes(paramName);
            const requiredLabel = isRequired ? " (required)" : " (optional)";

            output += `  ${paramName}${requiredLabel}\n`;
            output += `    Type: ${param.type || 'unknown'}\n`;
            if (param.description) {
              output += `    Description: ${param.description}\n`;
            }
            if (param.enum) {
              output += `    Allowed values: ${param.enum.join(', ')}\n`;
            }
            if (param.items) {
              output += `    Items: ${JSON.stringify(param.items)}\n`;
            }
            if (param.default !== undefined) {
              output += `    Default: ${param.default}\n`;
            }
          });
        } else {
          output += "  No parameters\n";
        }

        return {
          success: true,
          output,
          displayOutput: `Schema for ${toolName}`
        };
      }

      // Handle var:VARIABLE_NAME format for specific variable details
      if (target.startsWith("var:")) {
        const varName = target.substring(4); // Remove "var:" prefix
        const variable = Variable.get(varName);

        if (!variable) {
          return {
            success: false,
            error: `Variable not found: ${varName}\n\nNote: Variables are only created when rendered. Use /? def:${varName} to see the definition.`
          };
        }

        // Format the variable details with colors matching def: output style
        const varDef = VariableDef.getOrCreate(variable.name);
        const isIntrinsic = VariableDef.isIntrinsic(variable.name);
        const isExplicit = VariableDef.isExplicit(variable.name);
        const defType = isIntrinsic ? 'intrinsic' : (isExplicit ? 'explicit' : 'implicit');
        let output = `${chalk.cyan(variable.name)} ${chalk.dim(`(${defType})`)}\n`;

        // Only show isNew if the variable has values
        if (variable.values.length > 0) {
          output += `weight: ${chalk.yellow(variable.weight)}, persists: ${chalk.yellow(variable.persists)}, renderFull: ${chalk.yellow(varDef.renderFull)}, isNew: ${chalk.yellow(variable.isNew)}\n`;
        } else {
          output += `weight: ${chalk.yellow(variable.weight)}, persists: ${chalk.yellow(variable.persists)}, renderFull: ${chalk.yellow(varDef.renderFull)}\n`;
        }

        // Show template
        if (varDef.template && varDef.template !== "%%") {
          const templatePreview = varDef.template.length > 60 ?
            varDef.template.substring(0, 60) + "..." : varDef.template;
          output += `template: ${chalk.magenta(`"${templatePreview.replace(/\n/g, "\\n")}"`)}\n`;
        } else if (varDef.template === "%%") {
          output += `template: ${chalk.magenta('"%%"')} ${chalk.dim('# default')}\n`;
        }

        // Show values with color coding
        if (variable.values.length === 0) {
          output += `${chalk.dim('values (0)')}\n`;
        } else if (variable.values.length === 1) {
          const valuePreview = variable.values[0].length > 100 ?
            variable.values[0].substring(0, 100) + "..." : variable.values[0];
          output += `value: ${chalk.green(`"${valuePreview.replace(/\n/g, "\\n")}"`)}\n`;
        } else {
          output += `${chalk.dim('values (' + variable.values.length + '):')}\n`;
          variable.values.forEach((value, index) => {
            const valuePreview = value.length > 100 ? value.substring(0, 100) + "..." : value;
            output += `  ${chalk.dim('[' + (index + 1) + ']')} ${chalk.green('"' + valuePreview.replace(/\n/g, "\\n") + '"')}\n`;
          });
        }

        // Show children if they exist with detailed formatting
        const birthChildren = Variable.findBirthChildren(varName);

        // Show adopted children (from template)
        const adoptedChildren = varDef.adoptedChildren.filter(child =>
          !birthChildren.some(birthChild => birthChild.name === child)
        );

        // Combine all children and sort by weight
        const allChildren = [
          ...birthChildren.map(child => ({ name: child.name, weight: child.weight, type: 'birth' })),
          ...adoptedChildren.map(child => {
            const childDef = VariableDef.getOrCreate(child);
            const childVar = Variable.get(child);
            return {
              name: child,
              weight: childVar?.weight || childDef.weight,
              type: 'adopted'
            };
          })
        ].sort((a, b) => {
          if (a.weight !== b.weight) return a.weight - b.weight;
          return a.name.localeCompare(b.name);
        });

        if (allChildren.length > 0) {
          output += `${chalk.dim('children (' + allChildren.length + '):')}\n`;

          allChildren.forEach(child => {
            const childVar = Variable.get(child.name);
            const childDef = VariableDef.getOrCreate(child.name);
            const isIntrinsic = VariableDef.isIntrinsic(child.name);
            const isExplicit = VariableDef.isExplicit(child.name);
            const defType = isIntrinsic ? 'intrinsic' : (isExplicit ? 'explicit' : 'implicit');

            // Show child with same format as parent variable
            output += `  - ${chalk.cyan(child.name)} ${chalk.dim(`(${defType})`)}\n`;

            // Only show isNew if the child variable exists and has values
            if (childVar && childVar.values.length > 0) {
              output += `    weight: ${chalk.yellow(child.weight)}, persists: ${chalk.yellow(childDef.persists)}, renderFull: ${chalk.yellow(childDef.renderFull)}, isNew: ${chalk.yellow(childVar.isNew)}\n`;
            } else {
              output += `    weight: ${chalk.yellow(child.weight)}, persists: ${chalk.yellow(childDef.persists)}, renderFull: ${chalk.yellow(childDef.renderFull)}\n`;
            }

            // Show template
            if (childDef.template && childDef.template !== "%%") {
              const templatePreview = childDef.template.length > 60 ?
                childDef.template.substring(0, 60) + "..." : childDef.template;
              output += `    template: ${chalk.magenta(`"${templatePreview.replace(/\n/g, "\\n")}"`)}\n`;
            } else if (childDef.template === "%%") {
              output += `    template: ${chalk.magenta('"%%"')} ${chalk.dim('# default')}\n`;
            }

            // Show child value if available with count
            if (childVar && childVar.values.length > 0) {
              const childValue = childVar.values.join(", ");
              const valuePreview = childValue.length > 60 ? childValue.substring(0, 60) + "..." : childValue;
              output += `    values (${childVar.values.length}): ${chalk.green(`"${valuePreview.replace(/\n/g, "\\n")}"`)}\n`;
            } else if (childVar) {
              output += `    ${chalk.dim('values (0)')}\n`;
            }
          });
        }

        return {
          success: true,
          output: output.trim(),
          displayOutput: `Details for ${varName}`
        };
      }

      // Handle render:VARIABLE_NAME format for rendered value
      if (target.startsWith("render:")) {
        const varName = target.substring(7); // Remove "render:" prefix

        try {
          const renderedValue = Variable.renderFull(varName);

          let output = `Rendered ${varName}:\n`;
          output += renderedValue;

          return {
            success: true,
            output: output.trim(),
            displayOutput: `Rendered ${varName}`
          };
        } catch (error: any) {
          return {
            success: false,
            error: `Error rendering ${varName}: ${error.message}`
          };
        }
      }

      // Handle def:VARIABLE_NAME format for variable definition with children tree
      if (target.startsWith("def:")) {
        const varName = target.substring(4); // Remove "def:" prefix
        const definition = VariableDef.getOrCreate(varName);

        // Build tree structure showing variable definition and its birth children
        const buildVariableTree = (varName: string, depth: number = 0, visited: Set<string> = new Set()): string => {
          // Prevent infinite recursion
          if (visited.has(varName)) {
            return `${varName}: [circular reference]\n`;
          }
          visited.add(varName);

          const def = VariableDef.getOrCreate(varName);
          const variable = Variable.get(varName);

          let output = "";

          // Show current variable with YAML-like formatting
          const indent = "  ".repeat(depth);
          const isIntrinsic = VariableDef.isIntrinsic(varName);
          const isExplicit = VariableDef.isExplicit(varName);
          const defType = isIntrinsic ? 'intrinsic' : (isExplicit ? 'explicit' : 'implicit');
          output += `${indent}name: ${chalk.cyan(`"${varName}"`)} ${chalk.dim(`(${defType})`)}\n`;
          output += `${indent}weight: ${chalk.yellow(def.weight)}, persists: ${chalk.yellow(def.persists)}, renderFull: ${chalk.yellow(def.renderFull)}\n`;

          if (def.env_var) {
            output += `${indent}env_var: ${chalk.cyan(`"${def.env_var}"`)}\n`;
          }
          if (def.getter) {
            output += `${indent}has_getter: ${chalk.yellow('true')}\n`;
          }

          // Always show template
          if (def.template && def.template !== "%%") {
            const templatePreview = def.template.length > 60 ?
              def.template.substring(0, 60) + "..." : def.template;
            output += `${indent}template: ${chalk.magenta(`"${templatePreview.replace(/\n/g, "\\n")}"`)}\n`;
          } else if (def.template === "%%") {
            output += `${indent}template: ${chalk.magenta('"%%"')} ${chalk.dim('# default')}\n`;
          }

          // Show current value if variable exists and has values with count
          if (variable && variable.values.length > 0) {
            const valuePreview = variable.values.join(", ").length > 60 ?
              variable.values.join(", ").substring(0, 60) + "..." : variable.values.join(", ");
            output += `${indent}values (${variable.values.length}): ${chalk.green(`"${valuePreview.replace(/\n/g, "\\n")}"`)}\n`;
          } else if (variable) {
            output += `${indent}${chalk.dim('values (0)')}\n`;
          }

          // Show birth children (prefix match)
          const birthChildren = Variable.findBirthChildren(varName);

          // Show adopted children (from template)
          const adoptedChildren = def.adoptedChildren.filter(child =>
            !birthChildren.some(birthChild => birthChild.name === child)
          );

          // Combine all children and sort by weight
          const allChildren = [
            ...birthChildren.map(child => ({ name: child.name, weight: child.weight, type: 'birth' })),
            ...adoptedChildren.map(child => {
              const childDef = VariableDef.getOrCreate(child);
              const childVar = Variable.get(child);
              return {
                name: child,
                weight: childVar?.weight || childDef.weight,
                type: 'adopted'
              };
            })
          ].sort((a, b) => {
            if (a.weight !== b.weight) return a.weight - b.weight;
            return a.name.localeCompare(b.name);
          });

          // Display children recursively
          if (allChildren.length > 0) {
            output += '\n';
            output += `${indent}${chalk.dim('children (' + allChildren.length + '):')}\n`;
            for (let i = 0; i < allChildren.length; i++) {
              const child = allChildren[i];
              // Build child tree with no indentation, we'll add it when outputting
              const childOutput = buildVariableTree(child.name, 0, new Set(visited));
              const lines = childOutput.split('\n').filter(line => line.trim());

              // First line gets the list marker
              if (lines.length > 0) {
                const firstLine = lines[0];
                output += `${indent}  - ${firstLine}\n`;

                // Remaining lines get normal indentation
                for (let j = 1; j < lines.length; j++) {
                  output += `${indent}    ${lines[j]}\n`;
                }

                // Add blank line after each child except the last one
                if (i < allChildren.length - 1) {
                  output += '\n';
                }
              }
            }
          }

          return output;
        };

        const treeOutput = buildVariableTree(varName);

        // Add definition details
        let output = "";
        // Remove the redundant header since all info is now in the YAML tree
        output += treeOutput;

        return {
          success: true,
          output: output.trim(),
          displayOutput: `Definition tree for ${varName}`
        };
      }

      // Handle defs - show all variable definitions
      if (target === "defs") {
        const allDefinitions = VariableDef.getAllDefinitions();

        if (allDefinitions.length === 0) {
          return {
            success: true,
            output: "No variable definitions found.",
            displayOutput: "No variable definitions"
          };
        }

        // Sort definitions by name
        allDefinitions.sort((a, b) => a.name.localeCompare(b.name));

        let output = "Variable Definitions:\n\n";
        allDefinitions.forEach(def => {
          output += `${def.name}\n`;
          output += `  Weight: ${def.weight}\n`;
          output += `  Persists: ${def.persists}\n`;
          output += `  Render Full: ${def.renderFull}\n`;
          if (def.env_var) {
            output += `  Environment Variable: ${def.env_var}\n`;
          }
          if (def.getter) {
            output += `  Has Getter: true\n`;
          }
          if (def.adoptedChildren.length > 0) {
            output += `  Adopted Children: ${def.adoptedChildren.join(", ")}\n`;
          }
          if (def.template && def.template !== "%%") {
            const templatePreview = def.template.length > 80 ?
              def.template.substring(0, 80) + "..." : def.template;
            output += `  Template: ${templatePreview.replace(/\n/g, "\\n")}\n`;
          }
          output += "\n";
        });

        return {
          success: true,
          output: output.trim(),
          displayOutput: `Found ${allDefinitions.length} variable definitions`
        };
      }

      if (target === "commands") {
        return {
          success: true,
          output: BUILT_IN_COMMANDS,
          displayOutput: "Slash commands"
        };
      }

      if (target === "all") {
        // Get tools
        const toolsResult = await this.introspect("tools");
        // Get commands
        const commandsResult = await this.introspect("commands");
        // Get env
        const envResult = await this.introspect("env");
        // Get context
        const contextResult = await this.introspect("context");
        // Get vars
        const varsResult = await this.introspect("vars");

        return {
          success: true,
          output: `${toolsResult.output}\n\n=== Slash Commands ===\n${commandsResult.output}\n\n=== Environment Variables ===\n${envResult.output}\n\n=== Context Usage ===\n${contextResult.output}\n\n=== Prompt Variables ===\n${varsResult.output}`,
          displayOutput: "Showing all introspection data"
        };
      }

      if (target === "env") {
        const envVars = Object.entries(process.env)
          .filter(([key]) => key.startsWith("ZDS_AI_AGENT_"))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => `${key}=${value}`)
          .join("\n");

        const count = envVars ? envVars.split("\n").length : 0;
        const output = envVars || "No ZDS_AI_AGENT_* environment variables found";
        return {
          success: true,
          output,
          displayOutput: `Found ${count} ZDS_AI_AGENT_* variables`
        };
      }

      if (target === "context") {
        if (!this.agent) {
          return {
            success: false,
            error: "Agent not available for context introspection"
          };
        }

        const currentTokens = this.agent.getCurrentTokenCount();
        const maxContext = this.agent.getMaxContextSize();
        const usagePercent = this.agent.getContextUsagePercent().toFixed(2);

        const output = `Current: ${currentTokens} tokens
Maximum: ${maxContext} tokens
Usage: ${usagePercent}%`;

        return {
          success: true,
          output,
          displayOutput: `Context: ${currentTokens}/${maxContext} tokens (${usagePercent}%)`
        };
      }

      if (target === "vars") {
        // Get all set variables from the Variable class
        const variables = Variable.getAllVariables();

        if (variables.length === 0) {
          return {
            success: true,
            output: "No prompt variables are currently set.",
            displayOutput: "No prompt variables set"
          };
        }

        // Sort variables by name
        variables.sort((a, b) => a.name.localeCompare(b.name));

        let output = "";
        variables.forEach(variable => {
          const value = variable.values.length === 1 ? variable.values[0] : variable.values.join(", ");
          const trimmedValue = value.length > 100 ? value.substring(0, 100) + "..." : value;
          output += `${variable.name}=${trimmedValue}\n`;
        });

        return {
          success: true,
          output: output.trim(),
          displayOutput: `Found ${variables.length} prompt variables`
        };
      }

      if (target === "tools") {
        // Check if the current model supports tools
        const supportsTools = this.agent?.llmClient?.getSupportsTools();
        if (supportsTools === false) {
          return {
            success: true,
            output: "This model does not support tools.\n\nNo tools are available in chat-only mode.",
            displayOutput: "This model does not support tools."
          };
        }

        const sections = await this.generateToolSections();
        const parts: string[] = [];
        if (sections.base) parts.push(sections.base);
        if (sections.skillz) parts.push(sections.skillz);
        if (sections.mcp) parts.push(sections.mcp);
        const output = parts.join("\n") || "No tools available.\n";
        const totalCount = sections.baseCount + sections.skillzCount + sections.mcpCount;

        return {
          success: true,
          output,
          displayOutput: `Found ${sections.baseCount} base, ${sections.skillzCount} skillz, ${sections.mcpCount} MCP tools (${totalCount} total)`
        };
      }

      return {
        success: false,
        error: `Unknown introspect target: ${target}. Available targets: tools, commands, env, context, vars, defs, def:VAR_NAME, all, tool:TOOL_NAME, var:VARIABLE_NAME, render:VARIABLE_NAME`
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Error during introspection: ${error.message}`
      };
    }
  }

  /**
   * Generate tool listing sections separated by type (base, skillz, mcp).
   * Used by buildSystemMessage() to populate APP:TOOLS:BASE/MCP/SKILLZ variables.
   */
  async generateToolSections(): Promise<{
    base: string; baseCount: number;
    skillz: string; skillzCount: number;
    mcp: string; mcpCount: number;
  }> {
    const allTools = await getAllLLMTools();

    const baseInternalTools = allTools.filter(t =>
      !t.function.name.startsWith("mcp__") && !t.function.name.startsWith("skill__")
    );
    const skillzTools = allTools.filter(t => t.function.name.startsWith("skill__"));
    const mcpTools = allTools.filter(t => t.function.name.startsWith("mcp__"));

    // Build base section
    let base = "";
    const toolClassInfo = this.agent?.getToolClassInfo() || [];
    const toolDescriptions = new Map<string, string>();
    baseInternalTools.forEach(tool => {
      toolDescriptions.set(tool.function.name, tool.function.description);
    });

    const classifiedTools = new Set<string>();
    const sortedClasses = [...toolClassInfo].sort((a: any, b: any) => a.className.localeCompare(b.className));
    sortedClasses.forEach(({ className, methods }: any) => {
      if (methods.length > 0) {
        base += `${className}:\n`;
        methods.sort().forEach((methodName: string) => {
          const description = toolDescriptions.get(methodName) || 'No description available';
          base += `  ${methodName} (${description})\n`;
          classifiedTools.add(methodName);
        });
      }
    });

    // Build skillz section
    let skillz = "";
    if (skillzTools.length > 0) {
      skillz += "Skillz:\n";
      skillzTools.sort((a, b) => a.function.name.localeCompare(b.function.name)).forEach(tool => {
        const displayName = tool.function.name.replace(/^skill__/, '');
        skillz += `  ${displayName} (${tool.function.description})\n`;
      });
    }

    // Build MCP section
    let mcp = "";
    if (mcpTools.length > 0) {
      const toolsByServer = new Map<string, string[]>();
      mcpTools.forEach(tool => {
        const parts = tool.function.name.split('__');
        if (parts.length >= 3 && parts[0] === 'mcp') {
          const serverName = parts[1];
          const toolName = parts.slice(2).join('__');
          if (!toolsByServer.has(serverName)) toolsByServer.set(serverName, []);
          toolsByServer.get(serverName)!.push(toolName);
        }
      });
      const sortedServers = Array.from(toolsByServer.keys()).sort();
      sortedServers.forEach(serverName => {
        mcp += `MCP Tools (${serverName}):\n`;
        toolsByServer.get(serverName)!.sort().forEach(toolName => {
          mcp += `  ${toolName} (mcp:${serverName})\n`;
        });
      });
    }

    return {
      base: base.trim(),
      baseCount: baseInternalTools.length,
      skillz: skillz.trim(),
      skillzCount: skillzTools.length,
      mcp: mcp.trim(),
      mcpCount: mcpTools.length
    };
  }

  getHandledToolNames(): string[] {
    return getHandledToolNames(this);
  }
}
