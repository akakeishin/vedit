import { describe, expect, it } from 'vitest';
import { mkdtempSync, promises as fsp } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  claimExportJob,
  exportJobPartialPath,
  readExportJob,
  recoverInterruptedExportJob,
  writeOwnedExportJob,
  writeExportJob,
  type ExportJobState,
} from './exportJob.js';
import { Project } from './project.js';
import { createProcessLeaseOwner } from './processIdentity.js';

function deadOwner(overrides: Partial<NonNullable<ExportJobState['owner']>> = {}): NonNullable<ExportJobState['owner']> {
  return {
    pid: 2_147_483_647,
    processStartToken: 'dead-process-start',
    leaseToken: 'dead-export-lease',
    acquiredAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

function runningJob(dir: string, overrides: Partial<ExportJobState> = {}): ExportJobState {
  return {
    id: 'j1',
    revision: 4,
    status: 'running',
    phase: 'encoding',
    startedAt: '2026-07-18T00:00:00.000Z',
    file: path.join(dir, 'exports', 'r4.mp4'),
    ...overrides,
  };
}

describe('export job persistence', () => {
  it('round-trips state and turns a stale running job into interrupted on recovery', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vedit-export-job-'));
    const job = runningJob(dir, { owner: deadOwner() });
    await fsp.mkdir(path.dirname(job.file), { recursive: true });
    const partial = exportJobPartialPath(job);
    await fsp.writeFile(partial, 'unfinished mp4');
    await writeExportJob(dir, job);
    expect((await readExportJob(dir))?.status).toBe('running');
    const recovered = await recoverInterruptedExportJob(dir);
    expect(recovered?.status).toBe('interrupted');
    expect(recovered?.finishedAt).toBeTruthy();
    expect((await readExportJob(dir))?.status).toBe('interrupted');
    await expect(fsp.access(partial)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a running job as success when its non-empty final file already exists', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vedit-export-job-finalized-'));
    const job = runningJob(dir, { phase: 'finalizing', owner: deadOwner() });
    await fsp.mkdir(path.dirname(job.file), { recursive: true });
    await fsp.writeFile(job.file, 'complete mp4');
    const partial = exportJobPartialPath(job);
    await fsp.writeFile(partial, 'stale partial');
    await writeExportJob(dir, job);

    const recovered = await recoverInterruptedExportJob(dir);

    expect(recovered).toMatchObject({
      id: job.id,
      revision: job.revision,
      status: 'success',
      phase: 'finalizing',
      file: job.file,
    });
    expect(recovered?.finishedAt).toBeTruthy();
    expect(recovered?.error).toBeUndefined();
    await expect(fsp.readFile(job.file, 'utf8')).resolves.toBe('complete mp4');
    await expect(fsp.access(partial)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readExportJob(dir))?.status).toBe('success');
  });

  it('tolerates a genuinely missing state as no job', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vedit-export-job-empty-'));
    expect(await readExportJob(dir)).toBeNull();
  });

  it('fails closed on corrupt durable state instead of overwriting a possibly live owner', async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'vedit-export-job-corrupt-')), 'project');
    const project = await Project.create(dir, 'corrupt-export-state');
    const statePath = path.join(dir, 'cache', 'export-job.json');
    const corrupt = '{"status":"running","owner":broken';
    await fsp.writeFile(statePath, corrupt);

    // Best-effort display remains compatible, but every ownership-changing
    // operation uses the strict reader and refuses to claim/recover.
    expect(await readExportJob(dir)).toBeNull();
    await expect(recoverInterruptedExportJob(project)).rejects.toMatchObject({ code: 'EXPORT_JOB_STATE_CORRUPT' });
    await expect(claimExportJob(project, runningJob(dir))).rejects.toMatchObject({ code: 'EXPORT_JOB_STATE_CORRUPT' });
    expect(await fsp.readFile(statePath, 'utf8')).toBe(corrupt);
  });

  it('does not recover or remove a live owner\'s running job and partial', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vedit-export-job-live-'));
    const job = runningJob(dir, { owner: createProcessLeaseOwner() });
    await fsp.mkdir(path.dirname(job.file), { recursive: true });
    const partial = exportJobPartialPath(job);
    await fsp.writeFile(partial, 'live encoder bytes');
    await writeExportJob(dir, job);

    const observed = await recoverInterruptedExportJob(dir);

    expect(observed).toMatchObject({ id: job.id, status: 'running', owner: job.owner });
    await expect(fsp.readFile(partial, 'utf8')).resolves.toBe('live encoder bytes');
  });

  it('requires the process-start token as well as PID before treating an owner as live', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vedit-export-job-pid-reuse-'));
    const job = runningJob(dir, {
      owner: deadOwner({ pid: process.pid, processStartToken: 'an-older-process-with-the-same-pid' }),
    });
    await fsp.mkdir(path.dirname(job.file), { recursive: true });
    const partial = exportJobPartialPath(job);
    await fsp.writeFile(partial, 'old process bytes');
    await writeExportJob(dir, job);

    expect((await recoverInterruptedExportJob(dir))?.status).toBe('interrupted');
    await expect(fsp.access(partial)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when a legacy running job has no provable owner', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vedit-export-job-ownerless-'));
    const job = runningJob(dir);
    await fsp.mkdir(path.dirname(job.file), { recursive: true });
    const partial = exportJobPartialPath(job);
    await fsp.writeFile(partial, 'unknown owner bytes');
    await writeExportJob(dir, job);

    expect((await recoverInterruptedExportJob(dir))?.status).toBe('running');
    await expect(fsp.readFile(partial, 'utf8')).resolves.toBe('unknown owner bytes');
  });

  it('enforces the lease across real Node processes and never reaps the child owner', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-export-job-process-'));
    const dir = path.join(root, 'project');
    await Project.create(dir, 'cross-process-export');
    const ready = path.join(root, 'ready.json');
    const release = path.join(root, 'release');
    const workerSource = `
      import { promises as fs } from 'node:fs';
      import path from 'node:path';
      import { setTimeout as delay } from 'node:timers/promises';
      const payload = JSON.parse(process.env.VEDIT_EXPORT_LEASE_WORKER_PAYLOAD);
      const exports = await import(payload.exportJobModule);
      const projects = await import(payload.projectModule);
      const project = new projects.Project(payload.dir);
      const proposed = {
        id: 'child-job', revision: 0, status: 'running', phase: 'encoding',
        startedAt: new Date().toISOString(), file: path.join(payload.dir, 'exports', 'child.mp4'),
      };
      const job = await exports.claimExportJob(project, proposed);
      await fs.mkdir(path.dirname(job.file), { recursive: true });
      await fs.writeFile(exports.exportJobPartialPath(job), 'child-owned-partial');
      // access(ready) is the parent-process barrier below. Publish that
      // barrier atomically so the parent can never observe an existing but
      // not-yet-complete JSON file on a busy filesystem.
      const readyTemp = payload.ready + '.part-' + process.pid;
      await fs.writeFile(readyTemp, JSON.stringify(job));
      await fs.rename(readyTemp, payload.ready);
      while (true) {
        try { await fs.access(payload.release); break; }
        catch { await delay(5); }
      }
      await exports.writeOwnedExportJob(project, {
        ...job, status: 'cancelled', finishedAt: new Date().toISOString(),
      });
      await fs.rm(exports.exportJobPartialPath(job), { force: true });
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', workerSource], {
      env: {
        ...process.env,
        VEDIT_EXPORT_LEASE_WORKER_PAYLOAD: JSON.stringify({
          dir,
          ready,
          release,
          exportJobModule: pathToFileURL(path.resolve('src/core/exportJob.ts')).href,
          projectModule: pathToFileURL(path.resolve('src/core/project.ts')).href,
        }),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const childDone = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`export lease worker exited ${code ?? signal}: ${stderr}`));
      });
    });

    try {
      const deadline = Date.now() + 5_000;
      while (true) {
        try { await fsp.access(ready); break; }
        catch {
          if (Date.now() >= deadline) throw new Error(`timed out waiting for export worker: ${stderr}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const childJob = JSON.parse(await fsp.readFile(ready, 'utf8')) as ExportJobState;
      const contender = new Project(dir, { timeoutMs: 1_000, retryMs: 5 });
      await expect(claimExportJob(contender, runningJob(dir, {
        id: 'parent-job', file: path.join(dir, 'exports', 'parent.mp4'),
      }))).rejects.toMatchObject({ code: 'EXPORT_JOB_CONFLICT', job: { id: 'child-job' } });

      expect((await recoverInterruptedExportJob(contender))?.status).toBe('running');
      await expect(fsp.readFile(exportJobPartialPath(childJob), 'utf8')).resolves.toBe('child-owned-partial');
    } finally {
      await fsp.writeFile(release, 'release');
      await childDone;
    }

    expect((await readExportJob(dir))?.status).toBe('cancelled');
  }, 10_000);

  it('rejects a state update made after lease ownership changes', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-export-job-lost-'));
    const dir = path.join(root, 'project');
    const project = await Project.create(dir, 'lost-export-lease');
    const claimed = await claimExportJob(project, runningJob(dir));
    await writeExportJob(dir, { ...claimed, owner: createProcessLeaseOwner() });

    await expect(writeOwnedExportJob(project, {
      ...claimed, phase: 'finalizing',
    })).rejects.toMatchObject({ code: 'EXPORT_JOB_LEASE_LOST' });
  });
});
