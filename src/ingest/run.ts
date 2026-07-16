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

export function run(cmd: string, args: string[], opts: { maxBuffer?: number } = {}): Promise<string> {
  if (cmd === 'ffmpeg') cmd = ffmpegBin();
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${stderr.slice(0, 2000) || err.message}`));
      else resolve(stdout);
    });
  });
}

/**
 * Like `run`, but also returns stderr on success. Needed for ffmpeg filters
 * (e.g. showinfo) that log their output to stderr at the default loglevel —
 * `run` discards stderr on the happy path, which would silently drop it.
 */
export function runCapture(cmd: string, args: string[], opts: { maxBuffer?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  if (cmd === 'ffmpeg') cmd = ffmpegBin();
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${stderr.slice(0, 2000) || err.message}`));
      else resolve({ stdout, stderr });
    });
  });
}

export function runBinary(cmd: string, args: string[]): Promise<Buffer> {
  if (cmd === 'ffmpeg') cmd = ffmpegBin();
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 1024 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd} failed: ${stderr.toString().slice(0, 2000)}`));
        else resolve(stdout);
      },
    );
  });
}
