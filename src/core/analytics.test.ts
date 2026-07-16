import { describe, expect, it } from 'vitest';
import {
  buildRetrospective,
  findDipsAndSpikes,
  mapRetentionToTimeline,
  parseRetentionCsv,
  type MotionChapterPoint,
} from './analytics.js';
import type { Manifest, SceneFile, Transcript } from './types.js';

// ---- fixtures ----

function baseManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    version: 1,
    name: 't',
    revision: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    sources: [
      { id: 's1', path: '/a.mp4', duration: 200, fps: 30, width: 1920, height: 1080, hasAudio: true },
      { id: 's2', path: '/b.mp4', duration: 200, fps: 30, width: 1920, height: 1080, hasAudio: true },
    ],
    timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 200 }], motion: [] },
    captions: { enabled: true, style: 'clean', maxChars: 24 },
    ...overrides,
  };
}

// ---- 1. parseRetentionCsv ----

describe('parseRetentionCsv', () => {
  it('parses the Japanese YouTube Studio column-name variant (percent scale, extra column ignored)', () => {
    const csv = [
      '動画の位置 (%),視聴者維持率 (%),相対視聴者維持率 (%)',
      '0,100,120',
      '10,85,110',
      '20,70,95',
      '50,45,80',
      '100,20,60',
    ].join('\n');
    expect(parseRetentionCsv(csv)).toEqual([
      { positionPct: 0, retentionPct: 100 },
      { positionPct: 10, retentionPct: 85 },
      { positionPct: 20, retentionPct: 70 },
      { positionPct: 50, retentionPct: 45 },
      { positionPct: 100, retentionPct: 20 },
    ]);
  });

  it('parses the English column-name variant with a fractional (0..1) position column, BOM, and quoted headers', () => {
    const csv = [
      '﻿"Video position","Absolute audience retention (%)"',
      '0.00,100.00',
      '0.10,88.50',
      '0.25,76.20',
      '0.50,55.00',
      '1.00,25.00',
    ].join('\n');
    const points = parseRetentionCsv(csv);
    expect(points).toHaveLength(5);
    expect(points[0]).toEqual({ positionPct: 0, retentionPct: 100 });
    expect(points[1].positionPct).toBeCloseTo(10, 5);
    expect(points[1].retentionPct).toBeCloseTo(88.5, 5);
    expect(points[4]).toEqual({ positionPct: 100, retentionPct: 25 });
  });

  it('auto-detects a header row that is not on line 1', () => {
    const csv = [
      '# exported 2026-07-16',
      '',
      'Video position (%),Audience retention (%)',
      '0,100',
      '50,60',
      '100,30',
    ].join('\n');
    expect(parseRetentionCsv(csv)).toEqual([
      { positionPct: 0, retentionPct: 100 },
      { positionPct: 50, retentionPct: 60 },
      { positionPct: 100, retentionPct: 30 },
    ]);
  });

  it('throws a descriptive error listing candidate columns for an unrecognized format', () => {
    const csv = ['Impressions,Click-through rate,Watch time', '1000,4.2,3200'].join('\n');
    expect(() => parseRetentionCsv(csv)).toThrow(/unrecognized/i);
    expect(() => parseRetentionCsv(csv)).toThrow(/Impressions/);
  });
});

// ---- 2. mapRetentionToTimeline ----

describe('mapRetentionToTimeline', () => {
  it('maps position% to source instant/word/scene across a cut between two source clips', () => {
    const m = baseManifest({
      timeline: {
        video: [
          { id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 40 },
          { id: 'c2', sourceId: 's2', srcIn: 10, srcOut: 50 },
        ],
        motion: [],
      },
    });
    // timeline: [0,40) -> s1 srcStart 0 ; [40,80) -> s2 srcStart 10
    const transcripts: Transcript[] = [
      { sourceId: 's1', language: 'ja', words: [{ id: 'w1', text: 'まえ', t0: 19, t1: 21, p: 1 }] },
      { sourceId: 's2', language: 'ja', words: [{ id: 'w2', text: 'あと', t0: 29, t1: 31, p: 1 }] },
    ];
    const sceneFiles: SceneFile[] = [
      { sourceId: 's1', scenes: [{ id: 'sc1', t0: 15, t1: 25, thumb: 'x', hasSpeech: true, energy: 0.5 }] },
      { sourceId: 's2', scenes: [{ id: 'sc2', t0: 25, t1: 35, thumb: 'y', hasSpeech: true, energy: 0.5 }] },
    ];
    const points = [
      { positionPct: 25, retentionPct: 90 }, // tl=20 -> before the cut (s1)
      { positionPct: 75, retentionPct: 40 }, // tl=60 -> after the cut (s2)
    ];
    const mapped = mapRetentionToTimeline(points, 80, m, transcripts, sceneFiles);

    expect(mapped[0].tlTime).toBeCloseTo(20, 5);
    expect(mapped[0].srcMoment).toEqual({ sourceId: 's1', srcTime: 20 });
    expect(mapped[0].word?.id).toBe('w1');
    expect(mapped[0].scene?.id).toBe('sc1');

    expect(mapped[1].tlTime).toBeCloseTo(60, 5);
    expect(mapped[1].srcMoment).toEqual({ sourceId: 's2', srcTime: 30 });
    expect(mapped[1].word?.id).toBe('w2');
    expect(mapped[1].scene?.id).toBe('sc2');
  });

  it('attaches the most recent chapter-card at or before the mapped timeline moment', () => {
    const m = baseManifest();
    const chapters: MotionChapterPoint[] = [
      { tlTime: 0, title: 'オープニング' },
      { tlTime: 50, title: '本編' },
      { tlTime: 150, title: 'まとめ' },
    ];
    const points = [{ positionPct: 40, retentionPct: 80 }]; // tl=80 with renderDurationSeconds=200
    const mapped = mapRetentionToTimeline(points, 200, m, [], [], chapters);
    expect(mapped[0].chapter?.title).toBe('本編');
  });

  it('returns null srcMoment for a point that falls outside the current timeline', () => {
    const m = baseManifest({ timeline: { video: [], motion: [] } });
    const points = [{ positionPct: 50, retentionPct: 50 }];
    const mapped = mapRetentionToTimeline(points, 100, m, []);
    expect(mapped[0].srcMoment).toBeNull();
    expect(mapped[0].scene).toBeNull();
  });
});

// ---- 3. findDipsAndSpikes ----

describe('findDipsAndSpikes', () => {
  /**
   * Piecewise-linear synthetic retention curve: a steep intro decline
   * (100 -> 70 over the first 15% of position, i.e. the first 30s at
   * renderDurationSeconds=200) followed by a gentle main decline
   * (70 -> 45), continuous at the seam so the intro/main split itself never
   * produces a false dip. A single dip and a single spike are then punched
   * into the main segment, spaced well apart (and away from the series
   * edges) so neither's local baseline window contaminates the other's.
   */
  function buildSyntheticPoints() {
    const N = 40; // positions every 2.5%
    const points: { positionPct: number; retentionPct: number }[] = [];
    for (let i = 0; i <= N; i++) {
      const pos = (i / N) * 100;
      const ret = pos <= 15 ? 100 - (pos / 15) * 30 : 70 - ((pos - 15) / 85) * 25;
      points.push({ positionPct: pos, retentionPct: ret });
    }
    const dipIndex = points.findIndex((p) => p.positionPct === 40);
    const spikeIndex = points.findIndex((p) => p.positionPct === 80);
    points[dipIndex] = { ...points[dipIndex], retentionPct: points[dipIndex].retentionPct - 15 };
    points[spikeIndex] = { ...points[spikeIndex], retentionPct: points[spikeIndex].retentionPct + 15 };
    return { points, dipIndex, spikeIndex };
  }

  it('flags a sharp dip and a sharp spike against local trend, and only those', () => {
    const { points, dipIndex, spikeIndex } = buildSyntheticPoints();
    const result = findDipsAndSpikes(points, { renderDurationSeconds: 200 });

    expect(result.dips).toHaveLength(1);
    expect(result.dips[0].index).toBe(dipIndex);
    expect(result.dips[0].deltaPct).toBeLessThanOrEqual(-4);

    expect(result.spikes).toHaveLength(1);
    expect(result.spikes[0].index).toBe(spikeIndex);
    expect(result.spikes[0].deltaPct).toBeGreaterThanOrEqual(4);
  });

  it('keeps the first introSeconds in a separate "イントロ離脱" bucket instead of the dip list', () => {
    const { points } = buildSyntheticPoints();
    const result = findDipsAndSpikes(points, { renderDurationSeconds: 200 });

    // positions 0, 5, 10, 15 fall within the 30s (=15% of 200s) intro window
    // and must never appear as dip/spike entries even though the intro drop
    // itself is steep.
    const introIndices = points
      .map((p, i) => i)
      .filter((i) => points[i].positionPct <= 15);
    for (const i of introIndices) {
      expect(result.dips.some((d) => d.index === i)).toBe(false);
      expect(result.spikes.some((s) => s.index === i)).toBe(false);
    }
    expect(result.introDropPct).toBeCloseTo(30, 5); // 100 -> 70 over the intro window
  });

  it('disables intro separation gracefully when renderDurationSeconds is omitted', () => {
    const { points } = buildSyntheticPoints();
    const result = findDipsAndSpikes(points);
    expect(result.introDropPct).toBe(0);
  });
});

// ---- 4. buildRetrospective ----

describe('buildRetrospective', () => {
  it('assembles a fact-only retrospective with source moment, quote, scene, and chapter for a detected dip', () => {
    const m = baseManifest();
    const transcripts: Transcript[] = [
      {
        sourceId: 's1',
        language: 'ja',
        words: [
          { id: 'w1', text: 'ここで', t0: 98, t1: 99.5, p: 1 },
          { id: 'w2', text: 'カメラを', t0: 99.5, t1: 100.8, p: 1 },
          { id: 'w3', text: '止めた', t0: 100.8, t1: 101.5, p: 1 },
        ],
      },
    ];
    const sceneFiles: SceneFile[] = [
      { sourceId: 's1', scenes: [{ id: 'sc-mid', t0: 90, t1: 110, thumb: 'x', hasSpeech: true, energy: 0.4 }] },
    ];
    const chapters: MotionChapterPoint[] = [
      { tlTime: 0, title: 'オープニング' },
      { tlTime: 80, title: '本編2章' },
    ];

    const N = 20;
    const points: { positionPct: number; retentionPct: number }[] = [];
    for (let i = 0; i <= N; i++) {
      const pos = (i / N) * 100;
      const ret = pos <= 15 ? 100 - (pos / 15) * 25 : 75 - ((pos - 15) / 85) * 25;
      points.push({ positionPct: pos, retentionPct: ret });
    }
    const dipIndex = points.findIndex((p) => p.positionPct === 50); // tl=100 at renderDurationSeconds=200
    points[dipIndex] = { ...points[dipIndex], retentionPct: points[dipIndex].retentionPct - 15 };

    const retro = buildRetrospective(points, 200, m, transcripts, sceneFiles, chapters);

    expect(retro.introDropPct).toBeCloseTo(25, 5);
    expect(retro.dips).toHaveLength(1);
    const dip = retro.dips[0];
    expect(dip.tlTime).toBeCloseTo(100, 5);
    expect(dip.srcMoment).toEqual({ sourceId: 's1', srcTime: 100 });
    expect(dip.quote).toContain('カメラを');
    expect(dip.scene?.id).toBe('sc-mid');
    expect(dip.chapter?.title).toBe('本編2章');
    // facts only — no hypotheses/reasons field anywhere on the result
    expect(retro).not.toHaveProperty('hypotheses');
    expect(dip).not.toHaveProperty('hypothesis');
  });

  it('returns no dips/spikes for a perfectly smooth decline', () => {
    const m = baseManifest();
    const points = Array.from({ length: 21 }, (_, i) => ({ positionPct: i * 5, retentionPct: 100 - i * 2.5 }));
    const retro = buildRetrospective(points, 200, m, [], [], [], { renderDurationSeconds: 200 });
    expect(retro.dips).toHaveLength(0);
    expect(retro.spikes).toHaveLength(0);
  });
});
