import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, promises as fsp, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Project } from './project.js';
import {
  listProjects,
  ProjectRegistryCorruptError,
  upsertProject,
} from './registry.js';

// Use the app-specific registry override so tests never change HOME or touch
// the user's real ~/.cache/vedit/projects.json.
let stateRoot: string;
let registryPathBeforeTest: string | undefined;
let scratchDirs: string[];

beforeEach(() => {
  stateRoot = mkdtempSync(path.join(tmpdir(), 'vedit-registry-state-'));
  scratchDirs = [];
  registryPathBeforeTest = process.env.VEDIT_REGISTRY_PATH;
  process.env.VEDIT_REGISTRY_PATH = path.join(stateRoot, 'projects.json');
});

afterEach(() => {
  if (registryPathBeforeTest === undefined) delete process.env.VEDIT_REGISTRY_PATH;
  else process.env.VEDIT_REGISTRY_PATH = registryPathBeforeTest;
  rmSync(stateRoot, { recursive: true, force: true });
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix = 'vedit-proj-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function registryFile(): string {
  return path.join(stateRoot, 'projects.json');
}

async function makeListedProject(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  // listProjects only uses the marker's existence; a worker need not invoke
  // Project.create (which would populate the registry before the race starts).
  await fsp.writeFile(path.join(dir, 'project.json'), '{}');
}

async function waitForFile(file: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fsp.access(file);
      return;
    } catch {
      await delay(10);
    }
  }
  throw new Error(`timed out waiting for ${file}`);
}

interface RegistryWorkerPayload {
  moduleUrl: string;
  ready: string;
  start: string;
  dir: string;
  name: string;
}

function startRegistryWorker(payload: RegistryWorkerPayload): Promise<void> {
  const workerSource = `
    import { promises as fs } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    const payload = JSON.parse(process.env.VEDIT_REGISTRY_WORKER_PAYLOAD);
    const { upsertProject } = await import(payload.moduleUrl);
    await fs.writeFile(payload.ready, 'ready');
    while (true) {
      try { await fs.access(payload.start); break; }
      catch { await delay(5); }
    }
    await upsertProject(payload.dir, payload.name);
  `;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', workerSource],
    {
      env: {
        ...process.env,
        VEDIT_REGISTRY_WORKER_PAYLOAD: JSON.stringify(payload),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`registry worker exited ${code ?? signal}: ${stderr}`));
    });
  });
}

describe('project registry', () => {
  it('upsert then list round-trips, most-recently-opened first', async () => {
    const root = scratchDir();
    const dirA = path.join(root, 'a');
    const dirB = path.join(root, 'b');
    await Project.create(dirA, 'A');
    await Project.create(dirB, 'B');

    const entries = await listProjects();
    expect(entries.map((e) => e.name)).toEqual(['B', 'A']);
  });

  it('re-upserting an existing dir refreshes it to the front instead of duplicating', async () => {
    const root = scratchDir();
    const dirA = path.join(root, 'a');
    const dirB = path.join(root, 'b');
    await Project.create(dirA, 'A');
    await Project.create(dirB, 'B');
    await upsertProject(dirA, 'A renamed');

    const entries = await listProjects();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ dir: dirA, name: 'A renamed' });
  });

  it('drops entries whose project directory no longer exists', async () => {
    const root = scratchDir();
    const dirA = path.join(root, 'a');
    await Project.create(dirA, 'A');
    await upsertProject(path.join(root, 'gone'), 'Ghost');

    const entries = await listProjects();
    expect(entries.map((e) => e.name)).toEqual(['A']);
  });

  it('self-heals: pruned entries are gone on the very next read, not just filtered from the return value', async () => {
    const root = scratchDir();
    const dirA = path.join(root, 'a');
    await Project.create(dirA, 'A');
    await upsertProject(path.join(root, 'gone-1'), 'Ghost1');
    await upsertProject(path.join(root, 'gone-2'), 'Ghost2');

    const first = await listProjects();
    expect(first.map((e) => e.name)).toEqual(['A']);

    // Deleting dirA's project.json after the fact (simulating the dir
    // vanishing between reads) proves the registry file itself, not just
    // the in-memory list, was rewritten by the prune above: a second call
    // starts from a registry that already has only 1 entry left.
    await fsp.rm(path.join(dirA, 'project.json'));
    const second = await listProjects();
    expect(second).toEqual([]);
  });

  it('keeps entries whose directory still has a valid project.json (does not over-prune)', async () => {
    const root = scratchDir();
    const dirA = path.join(root, 'a');
    const dirB = path.join(root, 'b');
    const dirC = path.join(root, 'c');
    await Project.create(dirA, 'A');
    await Project.create(dirB, 'B');
    await Project.create(dirC, 'C');

    const entries = await listProjects();
    expect(entries.map((e) => e.name).sort()).toEqual(['A', 'B', 'C']);
  });

  it('tolerates a missing registry file (no ~/.cache/vedit/projects.json yet)', async () => {
    // Nothing has ever called upsertProject in this test's isolated state, so
    // the registry file doesn't exist at all.
    await expect(listProjects()).resolves.toEqual([]);
  });

  it.each([
    ['', 'empty'],
    ['{ not valid json', 'invalid JSON'],
    ['{"unexpected":true}', 'non-array JSON'],
    ['[{"dir":7,"name":"bad","lastOpened":"now"}]', 'invalid entry'],
  ])('preserves a %s registry and fails actionably instead of overwriting it (%s)', async (raw) => {
    const registryDir = path.dirname(registryFile());
    await fsp.mkdir(registryDir, { recursive: true });
    const file = registryFile();
    await fsp.writeFile(file, raw);

    const failure = await listProjects().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProjectRegistryCorruptError);
    if (!(failure instanceof ProjectRegistryCorruptError)) return;

    expect(failure.message).toContain('original bytes were preserved');
    expect(failure.registryPath).toBe(file);
    expect(await fsp.readFile(file, 'utf8')).toBe(raw);
    expect(await fsp.readFile(failure.quarantinePath, 'utf8')).toBe(raw);

    // A later mutation must not interpret the still-malformed primary as an
    // empty registry and erase discoverability. The content-addressed
    // quarantine is reused rather than spawning unlimited duplicate files.
    await expect(upsertProject('/would-overwrite', 'No')).rejects.toBeInstanceOf(
      ProjectRegistryCorruptError,
    );
    expect(await fsp.readFile(file, 'utf8')).toBe(raw);
    const quarantines = (await fsp.readdir(registryDir)).filter((name) => name.includes('.corrupt-'));
    expect(quarantines).toHaveLength(1);
  });

  it('quarantines a malformed primary and restores the last valid generation from backup', async () => {
    const root = scratchDir();
    const dirA = path.join(root, 'a');
    const dirB = path.join(root, 'b');
    await makeListedProject(dirA);
    await makeListedProject(dirB);
    await upsertProject(dirA, 'A');
    await upsertProject(dirB, 'B');

    const malformed = '{ interrupted write';
    await fsp.writeFile(registryFile(), malformed);

    // The backup is the complete generation before B was added. Recovery is
    // explicit and conservative: A remains discoverable and the bad primary
    // is retained for inspection rather than guessed at or discarded.
    const recovered = await listProjects();
    expect(recovered.map((entry) => entry.name)).toEqual(['A']);
    expect(JSON.parse(await fsp.readFile(registryFile(), 'utf8'))).toMatchObject([
      { dir: dirA, name: 'A' },
    ]);
    const quarantine = (await fsp.readdir(path.dirname(registryFile())))
      .find((name) => name.startsWith('projects.json.corrupt-'));
    expect(quarantine).toBeDefined();
    expect(await fsp.readFile(path.join(path.dirname(registryFile()), quarantine!), 'utf8'))
      .toBe(malformed);
  });

  it('restores a missing primary from its durable backup', async () => {
    const root = scratchDir();
    const dirA = path.join(root, 'a');
    await makeListedProject(dirA);
    await upsertProject(dirA, 'A');
    await fsp.rm(registryFile());

    await expect(listProjects()).resolves.toMatchObject([{ dir: dirA, name: 'A' }]);
    await expect(fsp.readFile(registryFile(), 'utf8')).resolves.toContain('"name": "A"');
  });

  it('refuses a malformed orphaned backup without replacing it', async () => {
    const file = registryFile();
    const backup = `${file}.backup`;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(backup, '[broken backup');

    const failure = await listProjects().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProjectRegistryCorruptError);
    if (!(failure instanceof ProjectRegistryCorruptError)) return;
    expect(failure.quarantinePath).toContain('projects.json.backup.corrupt-');
    expect(await fsp.readFile(backup, 'utf8')).toBe('[broken backup');
    await expect(fsp.access(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reclaims a lock whose recorded owner process is gone', async () => {
    const file = registryFile();
    const lockDir = `${file}.lock`;
    await fsp.mkdir(lockDir, { recursive: true });
    await fsp.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({
      pid: 2_147_483_647,
      token: 'dead-owner',
      acquiredAt: '2000-01-01T00:00:00.000Z',
    }));

    await expect(listProjects()).resolves.toEqual([]);
    await expect(fsp.access(lockDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes simultaneous updates from separate processes without losing an entry', {
    timeout: 30_000,
  }, async () => {
    const workerCount = 8;
    const root = scratchDir('vedit-registry-race-');
    const start = path.join(root, 'start');
    const moduleUrl = new URL('./registry.ts', import.meta.url).href;
    const workers: Promise<void>[] = [];
    const readyFiles: string[] = [];

    for (let index = 0; index < workerCount; index++) {
      const dir = path.join(root, `project-${index}`);
      const ready = path.join(root, `ready-${index}`);
      await makeListedProject(dir);
      readyFiles.push(ready);
      workers.push(startRegistryWorker({
        moduleUrl,
        ready,
        start,
        dir,
        name: `Project ${index}`,
      }));
    }

    // Every child has loaded the module and is waiting on the same barrier,
    // so the test exercises real cross-process contention deterministically.
    await Promise.all(readyFiles.map((file) => waitForFile(file)));
    await fsp.writeFile(start, 'go');
    await Promise.all(workers);

    const entries = await listProjects();
    expect(entries).toHaveLength(workerCount);
    expect(entries.map((entry) => entry.name).sort()).toEqual(
      Array.from({ length: workerCount }, (_, index) => `Project ${index}`).sort(),
    );
    await expect(fsp.access(`${registryFile()}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
    const persisted: unknown = JSON.parse(await fsp.readFile(registryFile(), 'utf8'));
    expect(persisted).toEqual(expect.any(Array));
  });
});
