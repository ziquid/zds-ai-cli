import { exec } from "child_process";
import { promisify } from "util";
import { ToolResult } from "../types/index.js";
import { ToolDiscovery, getHandledToolNames } from "./tool-discovery.js";
import type { LLMAgent } from "../agent/llm-agent";
// import type { StreamingLLMAgent } from "../agent/streaming-agent";

const execAsync = promisify(exec);

const DEFAULT_NEGATIVE_PROMPT =
  "score_6, score_5, score_4, (worst quality:1.2), (low quality:1.2), (normal quality:1.2), lowres, bad anatomy, bad hands, signature, watermarks, ugly, imperfect eyes, skewed eyes, unnatural face, unnatural body, error, extra limb, missing limbs";

export class ImageTool implements ToolDiscovery {
  private agent: LLMAgent; // Reference to the LLMAgent

  setAgent(agent: LLMAgent) {
    this.agent = agent;
  }

  getHandledToolNames(): string[] {
    return getHandledToolNames(this);
  }

  /**
   * Generate an image using AI image generation.
   * Uses generate_image_sd.sh script with Stable Diffusion.
   */
  async generateImage(
    prompt: string,
    negativePrompt?: string,
    width?: number,
    height?: number,
    model?: string,
    sampler?: string,
    configScale?: number,
    numSteps?: number,
    nsfw?: boolean,
    name?: string,
    move?: boolean,
    seed?: number
  ): Promise<ToolResult> {
    try {
      if (!prompt) {
        return {
          success: false,
          error: "Prompt is required",
          output: "Prompt is required"
        };
      }

      if (!this.agent) {
        return {
          success: false,
          error: "Agent not available",
          output: "Agent not available"
        };
      }

      // Get the agent's home directory and create Images path
      const agentHome = process.env.ZDS_AI_AGENT_HOME_DIR;
      if (!agentHome) {
        return {
          success: false,
          error: "Agent home directory not found",
          output: "Agent home directory not found"
        };
      }

      // Set defaults
      const defaultNegativePrompt = DEFAULT_NEGATIVE_PROMPT;
      const finalModel = model || "cyberrealisticPony_v130";
      const finalWidth = Math.floor(width || 480);
      const finalHeight = Math.floor(height || 720);
      const finalSampler = sampler || "DPM++ 2M Karras";
      const finalConfigScale = configScale || 5.0;
      const finalNumSteps = Math.floor(numSteps || 30);
      const finalNsfw = nsfw !== undefined ? nsfw : false;
      const finalMove = move !== undefined ? move : false;
      const finalNegativePrompt = negativePrompt || defaultNegativePrompt;

      // Handle NSFW flag: when nsfw=true, allow NSFW content (prepend to prompt)
      // when nsfw=false (default), avoid NSFW content (prepend to negative prompt)
      const finalPrompt = finalNsfw ? `NSFW, ${prompt}` : prompt;

      // If nsfw is on, strip out any "NSFW" from negative prompt (case-insensitive)
      let finalNegativePromptWithNsfw: string;
      if (finalNsfw) {
        // Remove all "NSFW" variants - keep replacing until none left
        finalNegativePromptWithNsfw = finalNegativePrompt;
        let prev = '';
        while (prev !== finalNegativePromptWithNsfw) {
          prev = finalNegativePromptWithNsfw;
          finalNegativePromptWithNsfw = finalNegativePromptWithNsfw
            .replace(/NSFW,?\s*/gi, '')  // Remove NSFW with optional comma and spaces
            .replace(/,\s*,/g, ',')  // Clean up double commas
            .replace(/^\s*,\s*/, '')  // Remove leading comma
            .trim();
        }
      } else {
        // nsfw is off, prepend "NSFW, " to block NSFW content
        finalNegativePromptWithNsfw = `NSFW, ${finalNegativePrompt}`;
      }

      // Escape prompts for shell
      const escapedPrompt = finalPrompt.replace(/'/g, "'\\''");
      const escapedNegativePrompt = finalNegativePromptWithNsfw.replace(/'/g, "'\\''");

      // Build command using generate_image_sd.sh
      let command = `generate_image_sd.sh '${escapedPrompt}' '${escapedNegativePrompt}'`;

      if (finalMove) {
        command += ' --move';
      }

      command += ` --width ${finalWidth} --height ${finalHeight} --cfg-scale ${finalConfigScale} --steps ${finalNumSteps} --sampler '${finalSampler}' --model '${finalModel}'`;

      if (seed !== undefined) {
        command += ` --seed ${Math.floor(seed)}`;
      }

      if (name) {
        const escapedName = name.replace(/'/g, "'\\''");
        command += ` --name '${escapedName}'`;
      }

      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout: 300000, // 5 minute timeout
          env: process.env
        });

        // Parse output to find the generated file path
        // The script must output the absolute path to the generated image
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];

        // Verify we got an absolute path
        if (!lastLine.startsWith('/')) {
          return {
            success: false,
            error: `Image generation script did not return a valid file path. Output: ${stdout}`,
            output: `Image generation failed - no file path returned.\n\nScript output:\n${stdout}`
          };
        }

        const filepath = lastLine;

        // Get file size if file exists
        let fileSize = "unknown";
        try {
          const { stdout: sizeOutput } = await execAsync(`ls -lh "${filepath}" 2>/dev/null | awk '{print $5}'`);
          fileSize = sizeOutput.trim() || "unknown";
        } catch {
          fileSize = "unknown";
        }

        return {
          success: true,
          output: `Image generated successfully\nPrompt: ${prompt}\nModel: ${finalModel}\nSize: ${finalWidth}x${finalHeight}\nSteps: ${finalNumSteps}\nGuidance: ${finalConfigScale}\nPath: ${filepath}\nFile Size: ${fileSize}`,
          displayOutput: `Generated image (${finalWidth}x${finalHeight})`
        };
      } catch (error: any) {
        return {
          success: false,
          error: `Image generation failed: ${error.message}`,
          output: `Image generation failed: ${error.message}`
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error generating image",
        output: error instanceof Error ? error.message : "Unknown error generating image"
      };
    }
  }

  /**
   * Caption an image using AI image captioning.
   * Uses joycaption.sh or fastcaption.sh script.
   */
  async captionImage(
    filename: string,
    backend: "joy" | "fast" = "fast"
  ): Promise<ToolResult> {
    try {
      if (!filename) {
        return {
          success: false,
          error: "Filename is required",
          output: "Filename is required"
        };
      }

      // Build command based on backend selection
      const scriptName = backend === "fast" ? "fastcaption.sh" : "joycaption.sh";
      const command = `${scriptName} '${filename.replace(/'/g, "'\\''")}'`;

      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout: 90000, // 90 second timeout
          shell: '/bin/zsh'
        });

        // If there's stderr output, include it but still return success if we got stdout
        if (stderr && !stdout) {
          return {
            success: false,
            error: `Image captioning failed: ${stderr}`,
            output: stderr
          };
        }

        const caption = stdout.trim();
        return {
          success: true,
          output: caption,
          displayOutput: `Caption: ${caption}`
        };
      } catch (error: any) {
        // Extract error details
        const errorMessage = error.message || "Unknown error";
        const stderr = error.stderr || "";
        const stdout = error.stdout || "";

        return {
          success: false,
          error: `Image captioning failed (code ${error.code || 'unknown'}): ${errorMessage}${stderr ? '\nstderr: ' + stderr : ''}${stdout ? '\nstdout: ' + stdout : ''}`,
          output: `Error code: ${error.code || 'unknown'}\n${errorMessage}${stderr ? '\nstderr: ' + stderr : ''}${stdout ? '\nstdout: ' + stdout : ''}`
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error captioning image",
        output: error instanceof Error ? error.message : "Unknown error captioning image"
      };
    }
  }

  /**
   * Compare an AI-generated image to its original generation prompt.
   * Extracts the prompt from PNG metadata using exiftool, captions the image, and analyzes match.
   */
  async compareImageToPrompt(
    filename: string
  ): Promise<ToolResult> {
    try {
      // Build command using compare-image-to-prompt.sh script
      const escapedFilename = filename.replace(/'/g, "'\\''");
      const command = `compare-image-to-prompt.sh '${escapedFilename}'`;

      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout: 120000, // 2 minute timeout (metadata extraction + captioning + LLM analysis)
          shell: '/bin/zsh'
        });

        // If there's stderr output, include it but still return success if we got stdout
        if (stderr && !stdout) {
          return {
            success: false,
            error: `Image comparison failed: ${stderr}`,
            output: stderr
          };
        }

        const analysis = stdout.trim();
        return {
          success: true,
          output: analysis,
          displayOutput: `Image compared to its generation prompt`
        };
      } catch (error: any) {
        // Extract error details
        const errorMessage = error.message || "Unknown error";
        const stderr = error.stderr || "";
        const stdout = error.stdout || "";

        return {
          success: false,
          error: `Image comparison failed (code ${error.code || 'unknown'}): ${errorMessage}${stderr ? '\nstderr: ' + stderr : ''}${stdout ? '\nstdout: ' + stdout : ''}`,
          output: `Error code: ${error.code || 'unknown'}\n${errorMessage}${stderr ? '\nstderr: ' + stderr : ''}${stdout ? '\nstdout: ' + stdout : ''}`
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error comparing image to prompt",
        output: error instanceof Error ? error.message : "Unknown error comparing image to prompt"
      };
    }
  }

  /**
   * Extract PNG metadata (generation settings) from a PNG file.
   * Uses exiftool to read embedded generation parameters.
   */
  async pngInfo(
    filename: string
  ): Promise<ToolResult> {
    try {
      if (!filename) {
        return {
          success: false,
          error: "Filename is required",
          output: "Filename is required"
        };
      }

      const escapedFilename = filename.replace(/'/g, "'\\''");
      const command = `exiftool -Parameters '${escapedFilename}'`;

      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout: 10000 // 10 second timeout
        });

        if (stderr && !stdout) {
          return {
            success: false,
            error: `Failed to read PNG metadata: ${stderr}`,
            output: stderr
          };
        }

        const metadata = stdout.trim();
        if (!metadata) {
          return {
            success: false,
            error: "No generation parameters found in file",
            output: "No generation parameters found in file"
          };
        }

        return {
          success: true,
          output: metadata,
          displayOutput: "PNG generation parameters extracted"
        };
      } catch (error: any) {
        const errorMessage = error.message || "Unknown error";
        const stderr = error.stderr || "";

        return {
          success: false,
          error: `Failed to read PNG metadata: ${errorMessage}${stderr ? '\n' + stderr : ''}`,
          output: `Failed to read PNG metadata: ${errorMessage}${stderr ? '\n' + stderr : ''}`
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error reading PNG metadata",
        output: error instanceof Error ? error.message : "Unknown error reading PNG metadata"
      };
    }
  }

  /**
   * List available Stable Diffusion models installed on the server.
   * Uses generate_image_sd.sh --list-models.
   */
  async listImageModels(): Promise<ToolResult> {
    try {
      const command = `generate_image_sd.sh --list-models`;

      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout: 30000, // 30 second timeout
          env: process.env
        });

        if (stderr && !stdout) {
          return {
            success: false,
            error: `Failed to list image models: ${stderr}`,
            output: stderr
          };
        }

        const modelList = stdout.trim();
        if (!modelList) {
          return {
            success: false,
            error: "No models found",
            output: "No models found"
          };
        }

        return {
          success: true,
          output: modelList,
          displayOutput: "Available Stable Diffusion models listed"
        };
      } catch (error: any) {
        const errorMessage = error.message || "Unknown error";
        const stderr = error.stderr || "";

        return {
          success: false,
          error: `Failed to list image models: ${errorMessage}${stderr ? '\n' + stderr : ''}`,
          output: `Failed to list image models: ${errorMessage}${stderr ? '\n' + stderr : ''}`
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error listing image models",
        output: error instanceof Error ? error.message : "Unknown error listing image models"
      };
    }
  }

  /**
   * List available LoRA models installed on the server.
   * Uses generate_image_sd.sh --list-loras.
   */
  async listImageLoras(): Promise<ToolResult> {
    try {
      const command = `generate_image_sd.sh --list-loras`;

      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout: 30000, // 30 second timeout
          env: process.env
        });

        if (stderr && !stdout) {
          return {
            success: false,
            error: `Failed to list LoRA models: ${stderr}`,
            output: stderr
          };
        }

        const loraList = stdout.trim();
        if (!loraList) {
          return {
            success: false,
            error: "No LoRA models found",
            output: "No LoRA models found"
          };
        }

        return {
          success: true,
          output: loraList,
          displayOutput: "Available LoRA models listed"
        };
      } catch (error: any) {
        const errorMessage = error.message || "Unknown error";
        const stderr = error.stderr || "";

        return {
          success: false,
          error: `Failed to list LoRA models: ${errorMessage}${stderr ? '\n' + stderr : ''}`,
          output: `Failed to list LoRA models: ${errorMessage}${stderr ? '\n' + stderr : ''}`
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error listing LoRA models",
        output: error instanceof Error ? error.message : "Unknown error listing LoRA models"
      };
    }
  }
  /**
   * Get detailed information about a specific LoRA model.
   * Uses generate_image_sd.sh --get-lora-details.
   */
  async getLoraDetails(
    loraName: string
  ): Promise<ToolResult> {
    try {
      if (!loraName) {
        return {
          success: false,
          error: "LoRA name is required",
          output: "LoRA name is required"
        };
      }

      const command = `generate_image_sd.sh --get-lora-details '${loraName.replace(/'/g, "'\\''")}'`;

      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout: 30000, // 30 second timeout
          env: process.env
        });

        if (stderr && !stdout) {
          return {
            success: false,
            error: `Failed to get LoRA details: ${stderr}`,
            output: stderr
          };
        }

        const loraDetails = stdout.trim();
        if (!loraDetails) {
          return {
            success: false,
            error: "No LoRA details found",
            output: "No LoRA details found"
          };
        }

        return {
          success: true,
          output: loraDetails,
          displayOutput: `LoRA details retrieved for: ${loraName}`
        };
      } catch (error: any) {
        const errorMessage = error.message || "Unknown error";
        const stderr = error.stderr || "";

        return {
          success: false,
          error: `Failed to get LoRA details: ${errorMessage}${stderr ? '\n' + stderr : ''}`,
          output: `Failed to get LoRA details: ${errorMessage}${stderr ? '\n' + stderr : ''}`
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error getting LoRA details",
        output: error instanceof Error ? error.message : "Unknown error getting LoRA details"
      };
    }
  }

  /**
   * Extract text from image files using OCR (Optical Character Recognition).
   * Uses extract-text.sh with tesseract/textra for text extraction.
   */
  async extractTextFromImage(
    filename: string
  ): Promise<ToolResult> {
    try {
      // Execute OCR extraction
      const command = `extract-text.sh "${filename}"`;
      const { stdout, stderr } = await execAsync(command, {
        timeout: 60000, // 60 second timeout for OCR
        shell: '/bin/zsh'
      });

      // Clean up output
      const extractedText = stdout.trim();
      const lineCount = extractedText.split('\n').length;
      const wordCount = extractedText.split(/\s+/).filter(word => word.length > 0).length;

      return {
        success: true,
        output: extractedText,
        displayOutput: `OCR complete (${wordCount} words, ${lineCount} lines)`,
        data: {
          file: filename,
          textLength: extractedText.length,
          wordCount: wordCount,
          lineCount: lineCount
        }
      };

    } catch (error: any) {
      // Extract error details
      const errorMessage = error.message || "Unknown error";
      const stderr = error.stderr || "";
      const stdout = error.stdout || "";

      return {
        success: false,
        error: `OCR text extraction failed (code ${error.code || 'unknown'}): ${errorMessage}${stderr ? '\nstderr: ' + stderr : ''}${stdout ? '\nstdout: ' + stdout : ''}`,
        output: `Error code: ${error.code || 'unknown'}\n${errorMessage}${stderr ? '\nstderr: ' + stderr : ''}${stdout ? '\nstdout: ' + stdout : ''}`
      };
    }
  }
}
