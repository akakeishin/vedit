import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Project, resolveWithinDir } from './project.js';
import {
  createProcessLeaseOwner,
  looksLikeProcessLeaseOwner,
  processLeaseOwnerStatus,
  sameProcessLeaseOwner,
  type ProcessLeaseOwner,
} from './processIdentity.js';

export type ExportJobStatus = 'running' | 'success' | 'error' | 'cancelled' | 'interrupted';
export type ExportJobPhase = 'preparing' | 'encoding' | 'finalizing';

export interface ExportJobState {
  id: string;
  revision: number;
  status: ExportJobStatus;
  phase?: ExportJobPhase;
  startedAt: string;
  finishedAt?: string;
  /** Final path. It does not exist until status=success. */
  file: string;
  partialBytes?: number;
  warnings?: string[];
  error?: string;
  /** Durable cross-daemon lease owner while status=running. */
  owner?: ProcessLeaseOwner;
}

export class ExportJobConflictError extends Error {
  readonly code = 'EXPORT_JOB_CONFLICT';

  constructor(readonly job: ExportJobState) {
    super('このプロジェクトのMP4書き出しが別のdaemonで実行中です');
    this.name = 'ExportJobConflictError';
  }
}

export class ExportJobLeaseLostError extends Error {
  readonly code = 'EXPORT_JOB_LEASE_LOST';

  constructor(readonly job: ExportJobState) {
    super(`export lease ownership changed for job ${job.id}`);
    this.name = 'ExportJobLeaseLostError';
  }
}

export class ExportJobStateCorruptError extends Error {
  readonly code = 'EXPORT_JOB_STATE_CORRUPT';

  constructor(readonly statePath: string, cause?: unknown) {
    super(`export job state is corrupt or unreadable: ${statePath}`, { cause });
    this.name = 'ExportJobStateCorruptError';
  }
}

function jobPath(projectDir: string): string {
  return path.join(projectDir, 'cache', 'export-job.json');
}

export function exportJobPartialPath(job: Pick<ExportJobState, 'id' | 'file'>): string {
  return path.join(
    path.dirname(job.file),
    `.${path.basename(job.file, '.mp4')}.partial-${job.id}.mp4`,
  );
}

async function safeJobPath(projectDir: string, file: string): Promise<string> {
  return resolveWithinDir(projectDir, path.relative(projectDir, path.resolve(file)));
}

function looksLikeJob(v: unknown): v is ExportJobState {
  return Boolean(
    v && typeof v === 'object' &&
    typeof (v as any).id === 'string' &&
    typeof (v as any).revision === 'number' &&
    typeof (v as any).status === 'string' &&
    typeof (v as any).startedAt === 'string' &&
    typeof (v as any).file === 'string',
  );
}

async function readExportJobStrict(projectDir: string): Promise<ExportJobState | null> {
  const target = jobPath(projectDir);
  try {
    const parsed = JSON.parse(await fs.readFile(target, 'utf8'));
    if (!looksLikeJob(parsed)) throw new ExportJobStateCorruptError(target);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof ExportJobStateCorruptError) throw error;
    throw new ExportJobStateCorruptError(target, error);
  }
}

/** Best-effort display read. Claim/recovery paths use the strict reader. */
export async function readExportJob(projectDir: string): Promise<ExportJobState | null> {
  try {
    return await readExportJobStrict(projectDir);
  } catch {
    return null;
  }
}

export async function writeExportJob(projectDir: string, job: ExportJobState): Promise<void> {
  const dir = path.join(projectDir, 'cache');
  await fs.mkdir(dir, { recursive: true });
  const target = jobPath(projectDir);
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(job, null, 2));
    await fs.rename(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

async function recoverInterruptedExportJobLocked(projectDir: string): Promise<ExportJobState | null> {
  const job = await readExportJobStrict(projectDir);
  if (!job || job.status !== 'running') return job;

  // Missing/malformed ownership metadata is not proof that an encoder is
  // gone. Likewise, a live owner (or an owner whose process start cannot be
  // inspected on this platform) keeps its lease and partial untouched.
  if (!looksLikeProcessLeaseOwner(job.owner)) return job;
  if (processLeaseOwnerStatus(job.owner) !== 'dead') return job;

  let finalExists = false;
  try {
    const finalPath = await safeJobPath(projectDir, job.file);
    const stat = await fs.stat(finalPath);
    finalExists = stat.isFile() && stat.size > 0;
  } catch { /* not finalized, invalid, or no longer present */ }

  let cleanupWarning: string | undefined;
  try {
    const partial = await safeJobPath(projectDir, exportJobPartialPath(job));
    await fs.rm(partial, { force: true });
  } catch (e: any) {
    cleanupWarning = `中断した一時ファイルを自動削除できませんでした: ${e?.message ?? String(e)}`;
  }

  const recovered: ExportJobState = finalExists
    ? {
        ...job,
        status: 'success',
        phase: 'finalizing',
        finishedAt: new Date().toISOString(),
        error: undefined,
        ...(cleanupWarning ? { warnings: [...(job.warnings ?? []), cleanupWarning] } : {}),
      }
    : {
        ...job,
        status: 'interrupted',
        finishedAt: new Date().toISOString(),
        error: 'アプリが終了したため書き出しが中断されました。もう一度実行してください',
        ...(cleanupWarning ? { warnings: [...(job.warnings ?? []), cleanupWarning] } : {}),
      };
  await writeExportJob(projectDir, recovered);
  return recovered;
}

/**
 * Recover only a job whose PID + process-start token prove its owner is dead.
 * The read/check/cleanup/write sequence runs under the existing per-project
 * cross-process persistence lock, so a new claimant cannot race recovery.
 */
export async function recoverInterruptedExportJob(
  projectOrDir: Project | string,
): Promise<ExportJobState | null> {
  const project = typeof projectOrDir === 'string'
    ? new Project(path.resolve(projectOrDir))
    : projectOrDir;
  return project.withPersistenceLock(() => recoverInterruptedExportJobLocked(project.dir));
}

/**
 * Atomically claim the one app-owned export slot for a project. A dead
 * previous owner is recovered first; a live or unprovable owner returns a
 * conflict without touching its state or partial file.
 */
export async function claimExportJob(
  project: Project,
  proposed: Omit<ExportJobState, 'owner'>,
): Promise<ExportJobState> {
  return project.withPersistenceLock(async () => {
    const existing = await recoverInterruptedExportJobLocked(project.dir);
    if (existing?.status === 'running') throw new ExportJobConflictError(existing);
    const claimed: ExportJobState = {
      ...proposed,
      owner: createProcessLeaseOwner(),
    };
    await writeExportJob(project.dir, claimed);
    return claimed;
  });
}

/** Persist a phase/terminal update only while this daemon still owns it. */
export async function writeOwnedExportJob(project: Project, job: ExportJobState): Promise<void> {
  if (!looksLikeProcessLeaseOwner(job.owner)) throw new ExportJobLeaseLostError(job);
  await project.withPersistenceLock(async () => {
    const current = await readExportJobStrict(project.dir);
    if (
      !current
      || current.id !== job.id
      || !looksLikeProcessLeaseOwner(current.owner)
      || !sameProcessLeaseOwner(current.owner, job.owner!)
    ) {
      throw new ExportJobLeaseLostError(job);
    }
    await writeExportJob(project.dir, job);
  });
}
