import { describe, expect, it } from 'vitest';
import { run, runBinary, runCapture } from './run.js';

describe('run cancellation', () => {
  it('terminates an in-flight child and reports AbortError', async () => {
    const controller = new AbortController();
    const child = run(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 25);

    await expect(child).rejects.toMatchObject({
      name: 'AbortError',
      message: 'operation cancelled',
    });
  });

  it.each([
    ['captured stderr', (signal: AbortSignal) => runCapture(
      process.execPath,
      ['-e', 'process.stderr.write("started"); setInterval(() => {}, 1000)'],
      { signal },
    )],
    ['binary stdout', (signal: AbortSignal) => runBinary(
      process.execPath,
      ['-e', 'process.stdout.write(Buffer.from([1, 2, 3])); setInterval(() => {}, 1000)'],
      { signal },
    )],
  ])('terminates an in-flight %s child through the same AbortSignal contract', async (_label, start) => {
    const controller = new AbortController();
    const child = start(controller.signal);
    setTimeout(() => controller.abort(), 25);

    await expect(child).rejects.toMatchObject({
      name: 'AbortError',
      message: 'operation cancelled',
    });
  });
});
