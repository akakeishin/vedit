import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Project } from '../core/project.js';
import { readExportResults } from '../core/exportResults.js';
import type { Manifest, MotionSpec, Transcript } from '../core/types.js';

const { renderFinalMock, renderCompositionMock, loadMotionSpecsMock } = vi.hoisted(() => ({
  renderFinalMock: vi.fn(),
  renderCompositionMock: vi.fn(),
  loadMotionSpecsMock: vi.fn(async () => ({})),
}));
vi.mock('./render.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./render.js')>();
  return {
    ...actual,
    renderFinal: renderFinalMock,
    renderComposition: renderCompositionMock,
    loadMotionSpecs: loadMotionSpecsMock,
  };
});

import { renderProjectMp4, renderProjectMp4Atomic } from './projectRender.js';

describe('renderProjectMp4', () => {
  beforeEach(() => {
    renderFinalMock.mockReset();
    renderCompositionMock.mockReset();
    loadMotionSpecsMock.mockClear();
  });

  async function normalProject(): Promise<Project> {
    const dir = mkdtempSync(path.join(tmpdir(), 'vedit-project-render-'));
    const p = await Project.create(dir, 'render');
    await p.commit(0, 'system', 'setup', {}, 'seed', (m) => ({
      ...m,
      sources: [{ id: 's1', path: '/media/a.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true }],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 }], motion: [] },
    }));
    return p;
  }

  it('renders the captured revision, finalizes it, and records the final path rather than the partial path', async () => {
    const p = await normalProject();
    const partial = path.join(p.dir, 'partial.mp4');
    const final = path.join(p.dir, 'exports', 'final.mp4');
    await fs.mkdir(path.dirname(final), { recursive: true });
    renderFinalMock.mockImplementationOnce(async (_m, _t, outPath) => {
      await fs.writeFile(outPath, 'mp4');
      return { file: outPath, warnings: ['warn'], captionsBurned: true, captionCueCount: 2, dialogueBurned: false, dialogueCount: 0 };
    });
    const phases: string[] = [];
    const result = await renderProjectMp4(p, partial, {
      manifest: await p.manifest(),
      recordFile: final,
      onPhase: (phase) => { phases.push(phase); },
      finalize: () => fs.rename(partial, final),
    });
    expect(result.file).toBe(final);
    expect(phases).toEqual(['preparing', 'encoding', 'finalizing']);
    await expect(fs.access(final)).resolves.toBeUndefined();
    const records = await readExportResults(p.dir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ ok: true, file: final, revision: 1, captionsBurned: true, captionCueCount: 2 });
  });

  it('does not replace the last-export record with a user cancellation', async () => {
    const p = await normalProject();
    const aborted = new Error('operation cancelled');
    aborted.name = 'AbortError';
    renderFinalMock.mockRejectedValueOnce(aborted);
    await expect(renderProjectMp4(p, path.join(p.dir, 'partial.mp4'))).rejects.toMatchObject({ name: 'AbortError' });
    expect(await readExportResults(p.dir)).toEqual([]);
  });

  it('records a genuine render failure for diagnosis', async () => {
    const p = await normalProject();
    renderFinalMock.mockRejectedValueOnce(new Error('ffmpeg missing'));
    await expect(renderProjectMp4(p, path.join(p.dir, 'out.mp4'))).rejects.toThrow(/ffmpeg missing/);
    const records = await readExportResults(p.dir);
    expect(records[0]).toMatchObject({ ok: false, revision: 1, error: 'ffmpeg missing' });
  });

  it('renders immutable transcript and motion snapshots captured before later project edits', async () => {
    const p = await normalProject();
    const transcriptV1: Transcript = {
      sourceId: 's1',
      language: 'ja',
      words: [{ id: 'w1', text: 'captured', t0: 0, t1: 1, p: 0.99 }],
    };
    const motionV1: MotionSpec = {
      id: 'mo1',
      type: 'callout',
      params: { text: 'captured motion' },
    };
    await p.writeTranscript(transcriptV1);
    const capturedManifest = await p.commit(
      1,
      'system',
      'capturable-inputs',
      {},
      'add transcript and motion',
      (m): Manifest => ({
        ...m,
        sources: m.sources.map((source) => source.id === 's1' ? { ...source, transcribed: true } : source),
        timeline: {
          ...m.timeline,
          motion: [{ id: 'mo1', spec: 'mo1.json', tlStart: 0, duration: 2 }],
        },
      }),
      { mo1: motionV1 },
    );
    const captured = await p.captureRenderInputs(capturedManifest.revision);

    await p.writeTranscript({
      ...transcriptV1,
      words: [{ id: 'w1', text: 'newer', t0: 0, t1: 1, p: 0.99 }],
    });
    await p.commit(
      capturedManifest.revision,
      'ui',
      'newer-motion',
      {},
      'change motion after export start',
      (m) => m,
      { mo1: { ...motionV1, params: { text: 'newer motion' } } },
    );

    renderFinalMock.mockResolvedValueOnce({
      file: path.join(p.dir, 'snapshot.mp4'),
      warnings: [],
      captionsBurned: true,
      captionCueCount: 1,
      dialogueBurned: false,
      dialogueCount: 0,
    });
    await renderProjectMp4(p, path.join(p.dir, 'snapshot.mp4'), captured);

    expect(renderFinalMock).toHaveBeenCalledOnce();
    expect(renderFinalMock.mock.calls[0][0]).toEqual(captured.manifest);
    expect(renderFinalMock.mock.calls[0][1]).toEqual([transcriptV1]);
    expect(renderFinalMock.mock.calls[0][3]).toMatchObject({ motionSpecs: { mo1: motionV1 } });
    expect(loadMotionSpecsMock).not.toHaveBeenCalled();
  });

  it('keeps a successful MP4 result when saving export history fails', async () => {
    const p = await normalProject();
    const out = path.join(p.dir, 'successful.mp4');
    renderFinalMock.mockImplementationOnce(async (_m, _t, outPath) => {
      await fs.writeFile(outPath, 'mp4');
      return {
        file: outPath,
        warnings: [],
        captionsBurned: false,
        captionCueCount: 0,
        dialogueBurned: false,
        dialogueCount: 0,
      };
    });
    await fs.rm(p.cacheDir, { recursive: true });
    await fs.writeFile(p.cacheDir, 'cache path deliberately unavailable');

    const result = await renderProjectMp4(p, out);

    expect(result.file).toBe(path.resolve(out));
    expect(result.warnings).toEqual([
      expect.stringMatching(/^書き出し結果の履歴を保存できませんでした:/),
    ]);
    await expect(fs.readFile(out, 'utf8')).resolves.toBe('mp4');
  });

  it('atomically replaces an existing final only after a non-empty partial succeeds', async () => {
    const p = await normalProject();
    const final = path.join(p.dir, 'final.mp4');
    await fs.writeFile(final, 'previous-good-export');
    let encodedPath = '';
    renderFinalMock.mockImplementationOnce(async (_m, _t, outPath) => {
      encodedPath = outPath;
      await fs.writeFile(outPath, 'new-complete-export');
      return {
        file: outPath,
        warnings: [],
        captionsBurned: false,
        captionCueCount: 0,
        dialogueBurned: false,
        dialogueCount: 0,
      };
    });

    const result = await renderProjectMp4Atomic(p, final, { manifest: await p.manifest() });

    expect(result.file).toBe(final);
    expect(encodedPath).not.toBe(final);
    expect(path.dirname(encodedPath)).toBe(path.dirname(final));
    expect(path.basename(encodedPath)).toMatch(/^\.final\.vedit-partial-.+\.mp4$/);
    await expect(fs.readFile(final, 'utf8')).resolves.toBe('new-complete-export');
    await expect(fs.access(encodedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves the prior final and removes its unique partial when encoding fails after writing bytes', async () => {
    const p = await normalProject();
    const final = path.join(p.dir, 'final.mp4');
    await fs.writeFile(final, 'previous-good-export');
    let partial = '';
    renderFinalMock.mockImplementationOnce(async (_m, _t, outPath) => {
      partial = outPath;
      await fs.writeFile(outPath, 'incomplete-new-export');
      throw new Error('synthetic encode failure');
    });

    await expect(renderProjectMp4Atomic(p, final, { manifest: await p.manifest() }))
      .rejects.toThrow(/synthetic encode failure/);

    await expect(fs.readFile(final, 'utf8')).resolves.toBe('previous-good-export');
    await expect(fs.access(partial)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readExportResults(p.dir))[0]).toMatchObject({
      ok: false,
      file: final,
      error: 'synthetic encode failure',
    });
  });

  it('does not replace a prior final when a nominally successful renderer produced no MP4', async () => {
    const p = await normalProject();
    const final = path.join(p.dir, 'final.mp4');
    await fs.writeFile(final, 'previous-good-export');
    renderFinalMock.mockResolvedValueOnce({
      file: 'not-created.mp4',
      warnings: [],
      captionsBurned: false,
      captionCueCount: 0,
      dialogueBurned: false,
      dialogueCount: 0,
    });

    await expect(renderProjectMp4Atomic(p, final, { manifest: await p.manifest() }))
      .rejects.toThrow(/non-empty MP4/);
    await expect(fs.readFile(final, 'utf8')).resolves.toBe('previous-good-export');
  });
});
