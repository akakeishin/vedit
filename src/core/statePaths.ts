import os from 'node:os';
import path from 'node:path';

export const VEDIT_REGISTRY_PATH_ENV = 'VEDIT_REGISTRY_PATH';
export const VEDIT_PRESETS_PATH_ENV = 'VEDIT_PRESETS_PATH';
export const VEDIT_MODEL_DIR_ENV = 'VEDIT_MODEL_DIR';

function explicitPath(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') return null;
  return path.resolve(value);
}

/**
 * Resolve the cross-project registry file. The app-specific override makes
 * tests and embedded runtimes independently isolatable without changing the
 * process HOME seen by unrelated libraries or child processes.
 */
export function resolveRegistryPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  return explicitPath(env, VEDIT_REGISTRY_PATH_ENV)
    ?? path.join(homeDir, '.cache', 'vedit', 'projects.json');
}

/** Resolve the global caption preset file, retaining the historical default. */
export function resolvePresetsPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  return explicitPath(env, VEDIT_PRESETS_PATH_ENV)
    ?? path.join(homeDir, '.config', 'vedit', 'presets.json');
}

/** Resolve the whisper.cpp model directory, retaining the historical default. */
export function resolveWhisperModelDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  return explicitPath(env, VEDIT_MODEL_DIR_ENV)
    ?? path.join(homeDir, '.cache', 'vedit', 'models');
}
