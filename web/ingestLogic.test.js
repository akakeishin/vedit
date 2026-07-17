import { describe, expect, it } from 'vitest';
import {
  bufferToHex,
  fingerprintRanges,
  formatBytes,
  isVideoFileName,
  planSummary,
  VIDEO_EXTENSIONS,
} from './ingestLogic.js';

describe('isVideoFileName', () => {
  it('accepts recognized video extensions case-insensitively', () => {
    expect(isVideoFileName('clip.mp4')).toBe(true);
    expect(isVideoFileName('CLIP.MOV')).toBe(true);
    expect(isVideoFileName('a.m4v')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isVideoFileName('notes.txt')).toBe(false);
    expect(isVideoFileName('archive.zip')).toBe(false);
    expect(isVideoFileName('noextension')).toBe(false);
    expect(isVideoFileName('')).toBe(false);
  });

  it('mirrors the server-side VIDEO_EXTENSIONS set', () => {
    expect([...VIDEO_EXTENSIONS].sort()).toEqual(['.m4v', '.mov', '.mp4']);
  });
});

describe('fingerprintRanges', () => {
  it('covers the first and last 1MB for a large file', () => {
    const size = 10 * 1024 * 1024;
    expect(fingerprintRanges(size)).toEqual({ headStart: 0, headLen: 1024 * 1024, tailStart: size - 1024 * 1024, tailLen: 1024 * 1024 });
  });

  it('clamps to the whole file when smaller than the chunk size', () => {
    expect(fingerprintRanges(500)).toEqual({ headStart: 0, headLen: 500, tailStart: 0, tailLen: 500 });
  });
});

describe('bufferToHex', () => {
  it('converts a Uint8Array to lowercase hex', () => {
    expect(bufferToHex(new Uint8Array([0, 255, 16, 1]))).toBe('00ff1001');
  });

  it('accepts a plain ArrayBuffer (as returned by SubtleCrypto.digest)', () => {
    const buf = new Uint8Array([171, 205]).buffer;
    expect(bufferToHex(buf)).toBe('abcd');
  });
});

describe('formatBytes', () => {
  it('formats bytes, KB, MB, GB with sensible precision', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024 * 1024 * 2.3)).toBe('2.3 GB');
  });

  it('is defensive against negative/non-finite input', () => {
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(NaN)).toBe('0 B');
  });
});

describe('planSummary', () => {
  it('sums count and total size across files', () => {
    const files = [{ size: 1000 }, { size: 2000 }, { size: 500 }];
    const summary = planSummary(files);
    expect(summary.count).toBe(3);
    expect(summary.totalBytes).toBe(3500);
    expect(summary.totalBytesLabel).toBe('3.4 KB');
  });

  it('handles an empty file list', () => {
    expect(planSummary([])).toEqual({ count: 0, totalBytes: 0, totalBytesLabel: '0 B' });
  });
});
