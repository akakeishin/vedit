import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, promises as fsp, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Project } from './project.js';
import { listProjects, upsertProject } from './registry.js';

// os.homedir() re-checks process.env.HOME on every call, so pointing it at a
// scratch dir per test isolates the registry file without touching the
// real ~/.cache/vedit/projects.json.
let home: string;
let realHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'vedit-home-'));
  realHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

describe('project registry', () => {
  it('upsert then list round-trips, most-recently-opened first', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-proj-'));
    const dirA = path.join(root, 'a');
    const dirB = path.join(root, 'b');
    await Project.create(dirA, 'A');
    await Project.create(dirB, 'B');

    const entries = await listProjects();
    expect(entries.map((e) => e.name)).toEqual(['B', 'A']);
  });

  it('re-upserting an existing dir refreshes it to the front instead of duplicating', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-proj-'));
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
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-proj-'));
    const dirA = path.join(root, 'a');
    await Project.create(dirA, 'A');
    await upsertProject(path.join(root, 'gone'), 'Ghost');

    const entries = await listProjects();
    expect(entries.map((e) => e.name)).toEqual(['A']);
  });

  it('self-heals: pruned entries are gone on the very next read, not just filtered from the return value', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-proj-'));
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
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-proj-'));
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
    // Nothing has ever called upsertProject in this test's fake HOME, so
    // the registry file doesn't exist at all.
    await expect(listProjects()).resolves.toEqual([]);
  });

  it('tolerates an empty or malformed registry file instead of throwing', async () => {
    const registryDir = path.join(home, '.cache', 'vedit');
    await fsp.mkdir(registryDir, { recursive: true });
    const registryFile = path.join(registryDir, 'projects.json');

    await fsp.writeFile(registryFile, '');
    await expect(listProjects()).resolves.toEqual([]);

    await fsp.writeFile(registryFile, '{ not valid json');
    await expect(listProjects()).resolves.toEqual([]);
  });
});
