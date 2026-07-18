import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Some ffmpeg builds (e.g. homebrew's minimal `ffmpeg`) lack drawtext/ass.
// Resolve a build that has them, preferring $VEDIT_FFMPEG.
const FFMPEG_CANDIDATES = [
  process.env.VEDIT_FFMPEG,
  '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
  '/usr/local/opt/ffmpeg-full/bin/ffmpeg',
  'ffmpeg',
].filter(Boolean) as string[];

let resolvedFfmpeg: string | null = null;
export function ffmpegBin(): string {
  if (resolvedFfmpeg) return resolvedFfmpeg;
  for (const c of FFMPEG_CANDIDATES) {
    try {
      if (c !== 'ffmpeg' && !existsSync(c)) continue;
      const filters = execFileSync(c, ['-hide_banner', '-filters'], { encoding: 'utf8' });
      if (filters.includes(' drawtext ')) {
        resolvedFfmpeg = c;
        return c;
      }
      if (!resolvedFfmpeg) resolvedFfmpeg = c; // usable fallback without drawtext
    } catch { /* try next */ }
  }
  return resolvedFfmpeg ?? 'ffmpeg';
}

export function ffmpegHasFilter(name: string): boolean {
  try {
    const filters = execFileSync(ffmpegBin(), ['-hide_banner', '-filters'], { encoding: 'utf8' });
    return filters.includes(` ${name} `);
  } catch {
    return false;
  }
}


/** ffmpeg's stderr starts with ~2KB of version banner; the error is at the END. */
function errExcerpt(stderr: string): string {
  if (stderr.length <= 2000) return stderr;
  return stderr.slice(0, 300) + '\n...[truncated]...\n' + stderr.slice(-1700);
}

export function run(cmd: string, args: string[], opts: { maxBuffer?: number; signal?: AbortSignal } = {}): Promise<string> {
  if (cmd === 'ffmpeg') cmd = ffmpegBin();
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, signal: opts.signal }, (err, stdout, stderr) => {
      if (err && opts.signal?.aborted) {
        const aborted = new Error('operation cancelled');
        aborted.name = 'AbortError';
        reject(aborted);
      } else if (err) {
        // Preserve child-process diagnostics for callers that can recover
        // from a specific failure mode.  In particular whisper.cpp's Metal
        // backend can terminate with SIGSEGV while the same model succeeds
        // on CPU; reducing every failure to an opaque Error string made a
        // safe, bounded CPU fallback impossible.
        reject(Object.assign(
          new Error(`${cmd} failed: ${errExcerpt(stderr) || err.message}`),
          { code: err.code, signal: err.signal, stderr },
        ));
      }
      else resolve(stdout);
    });
  });
}

/**
 * Like `run`, but also returns stderr on success. Needed for ffmpeg filters
 * (e.g. showinfo) that log their output to stderr at the default loglevel —
 * `run` discards stderr on the happy path, which would silently drop it.
 */
export function runCapture(cmd: string, args: string[], opts: { maxBuffer?: number; signal?: AbortSignal } = {}): Promise<{ stdout: string; stderr: string }> {
  if (cmd === 'ffmpeg') cmd = ffmpegBin();
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, signal: opts.signal }, (err, stdout, stderr) => {
      if (err && opts.signal?.aborted) {
        const aborted = new Error('operation cancelled');
        aborted.name = 'AbortError';
        reject(aborted);
      } else if (err) reject(new Error(`${cmd} failed: ${errExcerpt(stderr) || err.message}`));
      else resolve({ stdout, stderr });
    });
  });
}

export function runBinary(
  cmd: string,
  args: string[],
  opts: { maxBuffer?: number; signal?: AbortSignal } = {},
): Promise<Buffer> {
  if (cmd === 'ffmpeg') cmd = ffmpegBin();
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { maxBuffer: opts.maxBuffer ?? 1024 * 1024 * 1024, encoding: 'buffer', signal: opts.signal },
      (err, stdout, stderr) => {
        if (err && opts.signal?.aborted) {
          const aborted = new Error('operation cancelled');
          aborted.name = 'AbortError';
          reject(aborted);
        } else if (err) reject(new Error(`${cmd} failed: ${errExcerpt(stderr.toString())}`));
        else resolve(stdout);
      },
    );
  });
}
