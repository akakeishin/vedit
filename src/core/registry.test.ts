import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
});
