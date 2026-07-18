import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

interface LockOwner {
  pid: number;
  token: string;
  acquiredAt: string;
}

const LOCK_WAIT_TIMEOUT_MS = 10_000;
const OWNERLESS_LOCK_STALE_MS = 30_000;

export class RegistryLockTimeoutError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(`timed out waiting for the project registry lock at ${lockPath}`);
    this.name = 'RegistryLockTimeoutError';
    this.lockPath = lockPath;
  }
}

async function processIsAlive(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM means the process exists but is owned by another user. Only
    // ESRCH proves that the recorded owner is gone.
    return error?.code !== 'ESRCH';
  }
}

function looksLikeOwner(value: unknown): value is LockOwner {
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isSafeInteger((value as any).pid) &&
    (value as any).pid > 0 &&
    typeof (value as any).token === 'string' &&
    (value as any).token.length > 0 &&
    typeof (value as any).acquiredAt === 'string'
  );
}

async function readOwner(lockDir: string): Promise<LockOwner | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(lockDir, 'owner.json'), 'utf8'));
    return looksLikeOwner(parsed) ? parsed : null;
  } catch {
    // mkdir necessarily precedes owner.json. A contender may observe that
    // tiny interval, so an absent owner is not immediately considered stale.
    return null;
  }
}

async function lockIsReclaimable(lockDir: string): Promise<boolean> {
  const owner = await readOwner(lockDir);
  if (owner) return !(await processIsAlive(owner.pid));

  try {
    const stat = await fs.stat(lockDir);
    return Date.now() - stat.mtimeMs > OWNERLESS_LOCK_STALE_MS;
  } catch (error: any) {
    // It disappeared between EEXIST and inspection; the caller should retry.
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

/**
 * Rename a lock directory out of the acquisition path before deleting it.
 * The rename is the ownership-changing operation; deletion can then race
 * neither a fresh acquirer nor another stale-lock reclaimer.
 */
async function retireLockDirectory(lockDir: string, suffix: string): Promise<boolean> {
  const retired = `${lockDir}.${suffix}-${process.pid}-${randomUUID()}`;
  try {
    await fs.rename(lockDir, retired);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  await fs.rm(retired, { recursive: true, force: true });
  return true;
}

async function releaseOwnedLock(lockDir: string, token: string): Promise<void> {
  const owner = await readOwner(lockDir);
  // If an external actor removed and recreated the path, never delete the
  // replacement lock. The random token distinguishes it even within one PID.
  if (!owner || owner.token !== token) return;
  await retireLockDirectory(lockDir, 'released');
}

/**
 * Serialize one complete registry read/modify/write transaction across both
 * callers in this process and other vedit processes. mkdir is the atomic lock
 * acquisition primitive; a dead PID (or an old owner-less interrupted mkdir)
 * is safely retired before a new owner enters.
 */
export async function withRegistryFileLock<T>(
  registryFile: string,
  action: () => Promise<T>,
): Promise<T> {
  const lockDir = `${registryFile}.lock`;
  await fs.mkdir(path.dirname(registryFile), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

  while (true) {
    const token = randomUUID();
    try {
      await fs.mkdir(lockDir);
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;

      if (await lockIsReclaimable(lockDir)) {
        await retireLockDirectory(lockDir, 'stale');
        continue;
      }
      if (Date.now() >= deadline) throw new RegistryLockTimeoutError(lockDir);

      // Bounded jitter avoids a convoy when several app/CLI processes start
      // together while retaining a short response time for normal updates.
      await delay(8 + Math.floor(Math.random() * 13));
      continue;
    }

    try {
      const owner: LockOwner = {
        pid: process.pid,
        token,
        acquiredAt: new Date().toISOString(),
      };
      await fs.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify(owner), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      await retireLockDirectory(lockDir, 'abandoned').catch(() => {});
      throw error;
    }

    try {
      return await action();
    } finally {
      await releaseOwnedLock(lockDir, token);
    }
  }
}
