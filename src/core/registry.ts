import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Cross-project registry so `vedit projects` can list everything the user
// has touched without scanning the filesystem. Lives outside any project
// dir (~/.cache), separate from per-project state.

export interface ProjectRegistryEntry {
  dir: string;
  name: string;
  lastOpened: string; // ISO timestamp
}

// os.homedir() re-reads process.env.HOME/USERPROFILE on every call (not
// cached at import time), so tests can point it at a tmpdir per-case.
function registryPath(): string {
  return path.join(os.homedir(), '.cache', 'vedit', 'projects.json');
}

async function readRegistry(): Promise<ProjectRegistryEntry[]> {
  try {
    return JSON.parse(await fs.readFile(registryPath(), 'utf8'));
  } catch {
    return [];
  }
}

async function writeRegistry(entries: ProjectRegistryEntry[]): Promise<void> {
  const p = registryPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(entries, null, 2));
}

/** Record or refresh a project's entry; most-recently-opened first. */
export async function upsertProject(dir: string, name: string): Promise<void> {
  const entries = await readRegistry();
  const next = entries.filter((e) => e.dir !== dir);
  next.unshift({ dir, name, lastOpened: new Date().toISOString() });
  await writeRegistry(next);
}

/** List known projects, dropping any whose directory no longer has a project.json. */
export async function listProjects(): Promise<ProjectRegistryEntry[]> {
  const entries = await readRegistry();
  const alive: ProjectRegistryEntry[] = [];
  for (const e of entries) {
    try {
      await fs.access(path.join(e.dir, 'project.json'));
      alive.push(e);
    } catch {
      /* project directory gone; drop it from the registry */
    }
  }
  if (alive.length !== entries.length) await writeRegistry(alive);
  return alive;
}
