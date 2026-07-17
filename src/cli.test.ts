import { describe, expect, it, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project } from './core/project.js';
import type { Word } from './core/types.js';

/**
 * CLI output-format tests for the READ-ONLY commands added in this change
 * (`qc`, `takes`, `retro`) — spawned as real subprocesses via `tsx` (a
 * project dependency; `node` alone can't run this codebase's `.js`-suffixed
 * NodeNext imports against `.ts` source, see src/cli.ts's own
 * ensureDaemon()) rather than imported in-process, since cli.ts calls
 * `main().catch(...)` at module load time based on `process.argv` and calls
 * `process.exit()` on failure — neither is safely interceptable from inside
 * the shared vitest worker.
 *
 * Deliberately scoped to commands that never call `ensureDaemon()` (Project
 * .open() reads directly, same as `vedit sources`/`vedit kit`) — a mutating
 * command like `intent-add` would need the daemon self-spawn, which only
 * works when invoked as compiled `dist/cli.js` under plain `node` (see
 * ensureDaemon's `process.execPath` re-spawn); that wiring is covered
 * end-to-end instead via server/daemon.test.ts's in-process startDaemon().
 */

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli.ts');

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(TSX_BIN, [CLI_ENTRY, ...args], { encoding: 'utf8', timeout: 20000 });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('cli: vedit qc', () => {
  let dir: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-cli-qc-'));
    dir = path.join(root, 'proj');
    await Project.create(dir, 'qc-cli');
  });

  it('prints a StaticCheckReport (no probe/tempo) as JSON for a project with nothing to flag', () => {
    const { status, stdout, stderr } = runCli(['qc', '--project', dir]);
    expect(status, stderr).toBe(0);
    const body = JSON.parse(stdout);
    expect(body.static).toEqual({ issues: [], counts: { errors: 0, warnings: 0, infos: 0 } });
    expect(body.probe).toBeUndefined();
    expect(body.tempo).toBeUndefined();
    expect(body.report).toBeUndefined();
  });

  it('--report writes a self-contained HTML file and includes its path in the JSON output', () => {
    const reportPath = path.join(dir, 'qc.html');
    const { status, stdout, stderr } = runCli(['qc', '--project', dir, '--report', reportPath]);
    expect(status, stderr).toBe(0);
    const body = JSON.parse(stdout);
    expect(body.report).toBe(reportPath);
    expect(body.static).toBeDefined();
  });
});

describe('cli: vedit qc surfaces a missing source file', () => {
  it('reports a source-missing error for a source whose path does not exist on disk', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-cli-qc-missing-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'qc-missing');
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      sources: [{ id: 's1', path: path.join(root, 'nope.mp4'), duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true }],
    }));
    const { status, stdout, stderr } = runCli(['qc', '--project', dir]);
    expect(status, stderr).toBe(0);
    const body = JSON.parse(stdout);
    expect(body.static.issues.some((i: any) => i.category === 'source-missing')).toBe(true);
    expect(body.static.counts.errors).toBeGreaterThanOrEqual(1);
  });
});

describe('cli: vedit takes', () => {
  it('fails with a clear error when no source is transcribed', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-cli-takes-empty-'));
    const dir = path.join(root, 'proj');
    await Project.create(dir, 'takes-empty');
    const { status, stderr } = runCli(['takes', '--project', dir]);
    expect(status).toBe(1);
    expect(stderr).toMatch(/no transcribed source/);
  });

  it('prints packTakes text for a source with a detected retake group', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-cli-takes-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'takes-cli');
    // "hello there friend" said twice, 1.5s apart -> one 2-utterance retake group.
    const words: Word[] = [
      { id: 'w0', text: 'hello', t0: 0, t1: 0.5, p: 0.9 },
      { id: 'w1', text: 'there', t0: 0.5, t1: 1.0, p: 0.9 },
      { id: 'w2', text: 'friend', t0: 1.0, t1: 1.5, p: 0.9 },
      { id: 'w3', text: 'hello', t0: 3.0, t1: 3.5, p: 0.9 },
      { id: 'w4', text: 'there', t0: 3.5, t1: 4.0, p: 0.9 },
      { id: 'w5', text: 'friend', t0: 4.0, t1: 4.5, p: 0.9 },
    ];
    await project.writeTranscript({ sourceId: 's1', language: 'en', words });
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: true }],
    }));
    const { status, stdout, stderr } = runCli(['takes', '--project', dir, '--source', 's1']);
    expect(status, stderr).toBe(0);
    expect(stdout).toMatch(/multi-take groups \(1 detected/);
    expect(stdout).toMatch(/★/); // recommendation marker
    expect(stdout).not.toMatch(/^\{/); // packTakes text, not JSON — out() prints strings verbatim
  });
});

describe('cli: vedit retro', () => {
  it('outputs structured JSON (introDropPct/dips/spikes) plus a fact-only human-readable summary', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-cli-retro-'));
    const dir = path.join(root, 'proj');
    await Project.create(dir, 'retro-cli');
    const csvPath = path.join(root, 'retention.csv');
    const rows = ['Video position (%),Audience retention (%)'];
    for (let pct = 0; pct <= 100; pct += 10) rows.push(`${pct},${100 - pct * 0.5}`);
    await fsp.writeFile(csvPath, rows.join('\n') + '\n');

    const { status, stdout, stderr } = runCli(['retro', csvPath, '--project', dir, '--render-duration', '300']);
    expect(status, stderr).toBe(0);
    const body = JSON.parse(stdout);
    expect(typeof body.introDropPct).toBe('number');
    expect(Array.isArray(body.dips)).toBe(true);
    expect(Array.isArray(body.spikes)).toBe(true);
    expect(body.summary).toMatch(/視聴者維持率ふりかえり/);
    expect(body.summary).toMatch(/仮説を出しません/);
  });

  it('fails with a clear error for an unrecognized CSV format', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-cli-retro-bad-'));
    const dir = path.join(root, 'proj');
    await Project.create(dir, 'retro-bad-cli');
    const csvPath = path.join(root, 'bad.csv');
    await fsp.writeFile(csvPath, 'foo,bar\n1,2\n');
    const { status, stderr } = runCli(['retro', csvPath, '--project', dir]);
    expect(status).toBe(1);
    expect(stderr).toMatch(/unrecognized retention CSV format/);
  });
});
