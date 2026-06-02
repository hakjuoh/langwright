import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { LangwrightConfig } from '../shared/types.js';

const configFileNames = [
  'langwright.config.ts',
  'langwright.config.js',
  'langwright.config.cjs',
];

let configPromise: Promise<LangwrightConfig> | undefined;

/**
 * Load and memoize the project-level Langwright configuration.
 *
 * `LANGWRIGHT_CONFIG` can point at an explicit file. Without it, Langwright
 * searches the current working directory for the standard config filenames.
 */
export function loadLangwrightConfig(): Promise<LangwrightConfig> {
  configPromise ??= loadConfig();
  return configPromise;
}

/**
 * Resolve the config path and import the first existing candidate.
 */
async function loadConfig(): Promise<LangwrightConfig> {
  const explicitConfigPath = process.env.LANGWRIGHT_CONFIG;
  const candidates = explicitConfigPath
    ? [path.resolve(process.cwd(), explicitConfigPath)]
    : configFileNames.map((fileName) => path.join(process.cwd(), fileName));

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return importConfig(candidate);
    }
  }

  return {};
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Import config through the consuming project's module resolver.
 *
 * This keeps peer dependency resolution aligned with the Playwright project
 * that is running the tests rather than this package's own install location.
 */
function importConfig(configPath: string): LangwrightConfig {
  const requireFromProject = createRequire(path.join(process.cwd(), 'package.json'));
  const loaded = requireFromProject(configPath) as {
    default?: LangwrightConfig;
    config?: LangwrightConfig;
  };

  return loaded.default ?? loaded.config ?? {};
}
