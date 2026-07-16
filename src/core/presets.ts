import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CaptionSettings } from './types.js';

// Style presets are global (not per-project) so a caption look can be
// reused across projects. Stored keyed by name; last save wins.

export interface Preset {
  name: string;
  captions: CaptionSettings;
  /** Free-form JSON for future preset fields (e.g. motion defaults). */
  extra?: Record<string, unknown>;
  savedAt: string;
}

function presetsPath(): string {
  return path.join(os.homedir(), '.config', 'vedit', 'presets.json');
}

async function readAll(): Promise<Record<string, Preset>> {
  try {
    return JSON.parse(await fs.readFile(presetsPath(), 'utf8'));
  } catch {
    return {};
  }
}

async function writeAll(presets: Record<string, Preset>): Promise<void> {
  const p = presetsPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(presets, null, 2));
}

export async function savePreset(name: string, captions: CaptionSettings, extra?: Record<string, unknown>): Promise<Preset> {
  const all = await readAll();
  const preset: Preset = { name, captions, extra, savedAt: new Date().toISOString() };
  all[name] = preset;
  await writeAll(all);
  return preset;
}

export async function loadPreset(name: string): Promise<Preset> {
  const preset = (await readAll())[name];
  if (!preset) throw new Error(`unknown preset: ${name}`);
  return preset;
}

export async function listPresets(): Promise<Preset[]> {
  return Object.values(await readAll());
}
