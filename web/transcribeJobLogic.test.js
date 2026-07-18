import { describe, expect, it } from 'vitest';
import { isTerminalTranscribeJob, mergeTranscribeJob } from './transcribeJobLogic.js';

const job = (status, updatedAt, extra = {}) => ({
  taskId: 'transcribe-1', sourceId: 's1', projectDir: '/p', status,
  phase: status === 'queued' ? 'queued' : status === 'running' ? 'transcribing' : 'finished',
  startedAt: '2026-07-18T00:00:00.000Z', updatedAt, ...extra,
});

describe('mergeTranscribeJob', () => {
  it('never lets a delayed queued POST snapshot overwrite WS terminal truth', () => {
    const terminal = job('error', '2026-07-18T00:00:02.000Z', { error: 'model missing' });
    const delayedPost = job('queued', '2026-07-18T00:00:00.000Z');
    expect(mergeTranscribeJob(terminal, delayedPost)).toBe(terminal);
  });

  it('accepts terminal truth over an active snapshot regardless of channel order', () => {
    const active = job('running', '2026-07-18T00:00:01.000Z');
    const done = job('success', '2026-07-18T00:00:02.000Z', { finishedAt: '2026-07-18T00:00:02.000Z' });
    expect(mergeTranscribeJob(active, done)).toBe(done);
    expect(isTerminalTranscribeJob(done)).toBe(true);
  });

  it('uses newer updatedAt within one state class and active rank as a legacy fallback', () => {
    const olderError = job('error', '2026-07-18T00:00:02.000Z', { error: 'old' });
    const newerError = job('error', '2026-07-18T00:00:03.000Z', { error: 'new' });
    expect(mergeTranscribeJob(olderError, newerError)).toBe(newerError);

    const queued = { ...job('queued', undefined), updatedAt: undefined };
    const running = { ...job('running', undefined), updatedAt: undefined };
    expect(mergeTranscribeJob(running, queued)).toBe(running);
  });
});
