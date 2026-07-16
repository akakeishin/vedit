import { execFile } from 'node:child_process';

export function run(cmd: string, args: string[], opts: { maxBuffer?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${stderr.slice(0, 2000) || err.message}`));
      else resolve(stdout);
    });
  });
}

export function runBinary(cmd: string, args: string[]): Promise<Buffer> {
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
