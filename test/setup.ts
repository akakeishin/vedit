import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll } from 'vitest';

// Global safety net for the whole suite. Project.create(), savePreset(), and
// model discovery are redirected through vedit-specific paths while HOME is
// left untouched for Node, third-party libraries, font discovery, and child
// processes. Child CLI processes inherit these variables automatically.
//
// setupFiles runs once per test file, so every file receives an independent
// state root and cannot collide with another Vitest worker.
let stateRoot: string;
const originalEnv: Record<string, string | undefined> = {};
const stateEnv = ['VEDIT_REGISTRY_PATH', 'VEDIT_PRESETS_PATH', 'VEDIT_MODEL_DIR'] as const;

function restoreEnv(name: (typeof stateEnv)[number]): void {
  const value = originalEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(() => {
  stateRoot = mkdtempSync(path.join(tmpdir(), 'vedit-test-state-'));
  for (const name of stateEnv) originalEnv[name] = process.env[name];
  process.env.VEDIT_REGISTRY_PATH = path.join(stateRoot, 'registry', 'projects.json');
  process.env.VEDIT_PRESETS_PATH = path.join(stateRoot, 'presets', 'presets.json');
  process.env.VEDIT_MODEL_DIR = path.join(stateRoot, 'models');
});

afterAll(() => {
  for (const name of stateEnv) restoreEnv(name);
  rmSync(stateRoot, { recursive: true, force: true });
});
