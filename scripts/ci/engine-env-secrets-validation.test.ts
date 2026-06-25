/**
 * Validates that `engine.env` secret-bearing variables in all workflow `.md` files
 * are from the AWF engine-env allowlist (AWF_ENGINE_ENV_SECRET_VARS).
 *
 * The AWF config spec §9.1 defines which variables may hold secrets in
 * strict mode. Instead of per-engine allowlists, the compiler should use
 * the AWF-derived list so that any engine can use any of the defined
 * secret-bearing variables.
 *
 * A "secret-bearing" variable in this context is one whose value references
 * `${{ secrets.* }}` syntax in the workflow frontmatter's `engine.env` block.
 */

import * as fs from 'fs';
import * as path from 'path';
import { AWF_ENGINE_ENV_SECRET_VARS } from '../../src/constants/source-credentials';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');

/**
 * Parse the YAML frontmatter from a workflow .md file.
 * Returns the raw frontmatter string, or null if not found.
 */
function extractFrontmatter(content: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : null;
}

/**
 * Parse `engine.env` entries from raw YAML frontmatter.
 * Returns a map of variable name → value string.
 * Only returns entries from the `engine.env` sub-object.
 */
function parseEngineEnv(frontmatter: string): Map<string, string> {
  const result = new Map<string, string>();

  // Find the `engine:` block
  const engineBlockMatch = frontmatter.match(/^engine:\s*\n((?:[ \t]+[^\n]*\n)*)/m);
  if (!engineBlockMatch) return result;

  const engineBlock = engineBlockMatch[1];

  // Find the `env:` sub-block inside engine:
  const envBlockMatch = engineBlock.match(/^[ \t]+env:\s*\n((?:[ \t]{4,}[^\n]*\n)*)/m);
  if (!envBlockMatch) return result;

  const envBlock = envBlockMatch[1];

  // Parse key: value pairs, skipping comment lines
  const lineRegex = /^[ \t]+([A-Z_][A-Z0-9_]*):\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRegex.exec(envBlock)) !== null) {
    const key = m[1];
    const value = m[2].trim();
    // Remove inline comments
    const valueWithoutComment = value.replace(/\s+#.*$/, '').trim();
    result.set(key, valueWithoutComment);
  }

  return result;
}

/**
 * Returns true if the value references a secret: `${{ secrets.* }}`
 */
function isSecretExpression(value: string): boolean {
  return /\$\{\{\s*secrets\.[A-Z_][A-Z0-9_]*\s*\}\}/i.test(value);
}

const mdFiles = fs.readdirSync(workflowsDir)
  .filter(f => f.endsWith('.md'))
  .sort();

describe('engine.env secret-bearing variable validation', () => {
  it('AWF_ENGINE_ENV_SECRET_VARS is engine-agnostic and non-empty', () => {
    expect(AWF_ENGINE_ENV_SECRET_VARS.length).toBeGreaterThan(0);
    // Verify the primary credentials for all engines are present
    expect(AWF_ENGINE_ENV_SECRET_VARS).toContain('OPENAI_API_KEY');        // Codex/OpenAI
    expect(AWF_ENGINE_ENV_SECRET_VARS).toContain('ANTHROPIC_API_KEY');     // Claude
    expect(AWF_ENGINE_ENV_SECRET_VARS).toContain('COPILOT_GITHUB_TOKEN');  // Copilot
    expect(AWF_ENGINE_ENV_SECRET_VARS).toContain('GEMINI_API_KEY');        // Gemini
    expect(AWF_ENGINE_ENV_SECRET_VARS).toContain('COPILOT_PROVIDER_API_KEY');
    expect(AWF_ENGINE_ENV_SECRET_VARS).toContain('COPILOT_PROVIDER_BASE_URL');
  });

  it.each(mdFiles)(
    '%s: engine.env secret variables must be from the AWF engine-env allowlist',
    (mdFile) => {
      const content = fs.readFileSync(path.join(workflowsDir, mdFile), 'utf-8');
      const frontmatter = extractFrontmatter(content);
      if (!frontmatter) return; // no frontmatter, skip

      const engineEnvVars = parseEngineEnv(frontmatter);
      const allowedSet = new Set<string>(AWF_ENGINE_ENV_SECRET_VARS);

      const violations: string[] = [];
      for (const [varName, value] of engineEnvVars) {
        if (isSecretExpression(value) && !allowedSet.has(varName)) {
          violations.push(
            `  ${varName}: ${value}\n` +
            `    → Variable is not in AWF_ENGINE_ENV_SECRET_VARS.\n` +
            `    → Only AWF source credentials (§9.1) and companion endpoint vars may hold secrets in engine.env.\n` +
            `    → Allowed: ${[...allowedSet].join(', ')}`
          );
        }
      }

      if (violations.length > 0) {
        throw new Error(
          `${mdFile}: found engine.env secret-bearing variables not in the AWF allowlist:\n` +
          violations.join('\n')
        );
      }
    }
  );
});
