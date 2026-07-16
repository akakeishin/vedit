import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listPresets, loadPreset, savePreset } from './presets.js';
import type { CaptionSettings } from './types.js';

let home: string;
let realHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'vedit-home-'));
  realHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

const captions: CaptionSettings = { enabled: true, style: 'bold', maxChars: 20 };

describe('presets', () => {
  it('save then load round-trips the caption settings', async () => {
    await savePreset('vlog', captions);
    const loaded = await loadPreset('vlog');
    expect(loaded.name).toBe('vlog');
    expect(loaded.captions).toEqual(captions);
    expect(loaded.savedAt).toBeTruthy();
  });

  it('carries free-form extra JSON through', async () => {
    await savePreset('vlog', captions, { motionPalette: '#ff0000' });
    const loaded = await loadPreset('vlog');
    expect(loaded.extra).toEqual({ motionPalette: '#ff0000' });
  });

  it('loadPreset throws for an unknown name', async () => {
    await expect(loadPreset('nope')).rejects.toThrow(/unknown preset/);
  });

  it('re-saving the same name overwrites it', async () => {
    await savePreset('vlog', captions);
    await savePreset('vlog', { ...captions, style: 'clean' });
    const loaded = await loadPreset('vlog');
    expect(loaded.captions.style).toBe('clean');
  });

  it('listPresets returns every saved preset', async () => {
    await savePreset('vlog', captions);
    await savePreset('short', { ...captions, maxChars: 16 });
    const all = await listPresets();
    expect(all.map((p) => p.name).sort()).toEqual(['short', 'vlog']);
  });

  it('listPresets is empty when nothing has been saved yet', async () => {
    expect(await listPresets()).toEqual([]);
  });
});
