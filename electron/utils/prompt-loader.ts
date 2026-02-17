import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolves the prompts directory. When running from compiled output (dist-electron),
 * prompts live at dist-electron/prompts. The build must copy electron/prompts there.
 */
function getPromptsDir(): string {
  // From electron/services/ollama-service.js -> dist-electron/services; prompts -> dist-electron/prompts
  return path.join(__dirname, '..', 'prompts');
}

/**
 * Load a prompt from electron/prompts/<name>.md and optionally substitute variables.
 * Variables in the file use double curly braces: {{variableName}}.
 */
export function loadPrompt(name: string, vars?: Record<string, string>): string {
  const promptsDir = getPromptsDir();
  const filePath = path.join(promptsDir, `${name}.md`);
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to load prompt ${name}: ${err}`);
  }
  content = content.trim();
  if (vars) {
    for (const [key, value] of Object.entries(vars)) {
      content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    }
  }
  return content;
}
