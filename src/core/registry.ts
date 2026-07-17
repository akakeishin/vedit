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

/**
 * List known projects, self-healing the registry as it goes: any entry
 * whose `dir` no longer has a project.json (deleted project, stale test
 * scratch dir, etc.) is dropped and the pruned list is written back. Every
 * caller of listProjects (currently just `vedit projects`) goes through
 * this same path, so the registry can never accumulate dead entries for
 * long — it prunes itself on the next read.
 *
 * fs.stat calls run in parallel (Promise.all) rather than sequentially, so
 * pruning stays fast even with a few hundred entries.
 */
export async function listProjects(): Promise<ProjectRegistryEntry[]> {
  const entries = await readRegistry();
  const checks = await Promise.all(
    entries.map(async (e) => {
      try {
        await fs.stat(path.join(e.dir, 'project.json'));
        return e;
      } catch {
        return null; // project directory gone; drop it from the registry
      }
    }),
  );
  const alive = checks.filter((e): e is ProjectRegistryEntry => e !== null);
  if (alive.length !== entries.length) await writeRegistry(alive);
  return alive;
}
