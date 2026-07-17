import { describe, expect, it } from 'vitest';
import type { KitFile, Manifest, MotionItem, MotionSpec } from '../core/types.js';
import { buildMotionAss, motionAssLines, type MotionBurnInput } from './motion.js';

const OUT = { width: 1920, height: 1080 };

function motionItem(partial: Partial<MotionItem> & { id: string; tlStart: number; duration: number }): MotionItem {
  return { spec: `motion/${partial.id}.json`, ...partial };
}
function spec(type: MotionSpec['type'], params: Record<string, unknown> = {}): MotionSpec {
  return { id: 'sp', type, params };
}

// ---- motionAssLines (pure) ----

describe('motionAssLines: timing (Start/End) matches MotionItem.tlStart/duration exactly, for all 4 presets', () => {
  const cases: MotionSpec['type'][] = ['chapter-card', 'lower-third', 'callout', 'cta'];
  for (const type of cases) {
    it(`${type}: Start=tlStart, End=tlStart+duration (assTime formatted)`, () => {
      const item = motionItem({ id: 'm1', tlStart: 12.5, duration: 3.25 });
      const { lines } = motionAssLines([{ item, spec: spec(type, { text: 'hello' }) }], OUT, '#4b9fff');
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.startsWith(`Dialogue: 0,0:00:12.50,0:00:15.75,motion,,0,0,0,,`)).toBe(true);
      }
    });
  }
});

describe('motionAssLines: custom-html is never burned, only counted', () => {
  it('excludes custom-html from lines and counts it', () => {
    const items: MotionBurnInput[] = [
      { item: motionItem({ id: 'm1', tlStart: 0, duration: 2 }), spec: spec('custom-html', {}) },
      { item: motionItem({ id: 'm2', tlStart: 3, duration: 2 }), spec: { id: 'sp2', type: 'custom-html', params: {}, html: '<div>hi</div>' } },
    ];
    const { lines, customHtmlSkipped } = motionAssLines(items, OUT, '#4b9fff');
    expect(lines).toEqual([]);
    expect(customHtmlSkipped).toBe(2);
  });

  it('a mix of burnable + custom-html only counts the custom-html ones and still emits lines for the rest', () => {
    const items: MotionBurnInput[] = [
      { item: motionItem({ id: 'm1', tlStart: 0, duration: 2 }), spec: spec('cta', { text: 'Subscribe' }) },
      { item: motionItem({ id: 'm2', tlStart: 3, duration: 2 }), spec: spec('custom-html', {}) },
    ];
    const { lines, customHtmlSkipped } = motionAssLines(items, OUT, '#4b9fff');
    expect(lines.length).toBeGreaterThan(0);
    expect(customHtmlSkipped).toBe(1);
  });

  it('an unrecognized/future type is silently skipped WITHOUT counting toward customHtmlSkipped', () => {
    const items: MotionBurnInput[] = [
      { item: motionItem({ id: 'm1', tlStart: 0, duration: 2 }), spec: { id: 'sp', type: 'future-type' as any, params: {} } },
    ];
    const { lines, customHtmlSkipped } = motionAssLines(items, OUT, '#4b9fff');
    expect(lines).toEqual([]);
    expect(customHtmlSkipped).toBe(0);
  });
});

describe('motionAssLines: accent colour resolution', () => {
  it('falls back to the caller-supplied defaultAccentHex when the spec has no params.palette', () => {
    const item = motionItem({ id: 'm1', tlStart: 0, duration: 4 });
    const { lines } = motionAssLines([{ item, spec: spec('cta', { text: 'Go' }) }], OUT, '#ff00ff');
    // cta's fill (OutlineColour slot \3c) should carry the default accent, BGR of #ff00ff = FF00FF (palindromic, so also serves as a smoke check).
    expect(lines[0]).toContain('\\3c&HFF00FF&');
  });

  it('a per-item params.palette hex overrides the default accent', () => {
    const item = motionItem({ id: 'm1', tlStart: 0, duration: 4 });
    const { lines } = motionAssLines([{ item, spec: spec('cta', { text: 'Go', palette: '#00ff88' }) }], OUT, '#4b9fff');
    expect(lines[0]).toContain('\\3c&H88FF00&'); // #00ff88 -> BGR 88FF00
    expect(lines[0]).not.toContain('\\3c&H6BFF4B&'); // NOT the default (#4b9fff BGR)
  });
});

describe('motionAssLines: chapter-card', () => {
  it('emits a full-frame background drawing, a centered title, an accent bar, and (with subtitle) a 4th event', () => {
    const item = motionItem({ id: 'm1', tlStart: 0, duration: 4 });
    const noSub = motionAssLines([{ item, spec: spec('chapter-card', { text: 'Chapter 1' }) }], OUT, '#4b9fff');
    expect(noSub.lines).toHaveLength(3); // bg + title + bar
    expect(noSub.lines[0]).toContain('\\p1}m 0 0 l 1920 0 l 1920 1080 l 0 1080'); // full-frame rect
    expect(noSub.lines[1]).toContain('Chapter 1');
    expect(noSub.lines[1]).toContain('\\fad(500,0)'); // css: moFade 0.5s

    const withSub = motionAssLines([{ item, spec: spec('chapter-card', { text: 'Chapter 1', subtitle: 'sub here' }) }], OUT, '#4b9fff');
    expect(withSub.lines).toHaveLength(4);
    expect(withSub.lines[3]).toContain('sub here');
  });

  it('the fade duration is clamped to the item\'s own duration when shorter than the 500ms preset default', () => {
    const item = motionItem({ id: 'm1', tlStart: 0, duration: 0.2 }); // 200ms total
    const { lines } = motionAssLines([{ item, spec: spec('chapter-card', { text: 'x' }) }], OUT, '#4b9fff');
    expect(lines[1]).toContain('\\fad(200,0)');
    expect(lines[1]).not.toContain('\\fad(500,0)');
  });
});

describe('motionAssLines: lower-third', () => {
  it('anchors bottom-left (an1), slides in from -14px via \\move, and fades over 0.4s', () => {
    const item = motionItem({ id: 'm1', tlStart: 0, duration: 4 });
    const { lines } = motionAssLines([{ item, spec: spec('lower-third', { text: 'Title', subtitle: 'Sub' }) }], OUT, '#4b9fff');
    // box event + accent stripe event
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('\\an1\\pos(');
    expect(lines[0]).toContain('\\move(');
    expect(lines[0]).toContain('\\fad(400,0)');
    expect(lines[0]).toContain('Title');
    expect(lines[0]).toContain('Sub');
    expect(lines[0]).toContain('\\bord'); // BorderStyle=3 auto-box padding
  });

  it('without a subtitle, the box text has no \\N run', () => {
    const item = motionItem({ id: 'm1', tlStart: 0, duration: 4 });
    const { lines } = motionAssLines([{ item, spec: spec('lower-third', { text: 'Title only' }) }], OUT, '#4b9fff');
    expect(lines[0]).not.toContain('\\N');
  });
});

describe('motionAssLines: callout', () => {
  it('anchors top-right (an9) and scale-pops in (fscx/fscy 80->100) with a fade', () => {
    const item = motionItem({ id: 'm1', tlStart: 0, duration: 4 });
    const { lines } = motionAssLines([{ item, spec: spec('callout', { text: 'Note' }) }], OUT, '#4b9fff');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('\\an9\\pos(');
    expect(lines[0]).toContain('\\fscx80\\fscy80');
    expect(lines[0]).toContain('\\t(0,350,\\fscx100\\fscy100)');
    expect(lines[0]).toContain('\\fad(350,0)');
    expect(lines[0]).toContain('\\b1'); // css: font-weight 700 -> bold
  });
});

describe('motionAssLines: cta', () => {
  it('anchors bottom-center (an2), solid accent fill, dark navy text, scale-pop entry', () => {
    const item = motionItem({ id: 'm1', tlStart: 0, duration: 4 });
    const { lines } = motionAssLines([{ item, spec: spec('cta', { text: 'Subscribe' }) }], OUT, '#4b9fff');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('\\an2\\pos(');
    expect(lines[0]).toContain('\\1c&H1F1004&'); // #04101f -> BGR 1F1004 (dark navy text)
    expect(lines[0]).toContain('Subscribe');
  });
});

describe('motionAssLines: text escaping', () => {
  it('escapes ASS override-tag metacharacters and turns newlines into \\N', () => {
    const item = motionItem({ id: 'm1', tlStart: 0, duration: 4 });
    const { lines } = motionAssLines([{ item, spec: spec('cta', { text: 'a{b}c\nd' }) }], OUT, '#4b9fff');
    expect(lines[0]).toContain('a\\{b\\}c\\Nd');
  });
});

// ---- buildMotionAss (document assembly + kit integration) ----

function manifest(motion: MotionItem[], captionsStyle = 'clean', kitPath?: string): Manifest {
  return {
    version: 1, name: 't', revision: 0, fps: 30, width: 1920, height: 1080,
    sources: [], timeline: { video: [], motion },
    captions: { enabled: true, style: captionsStyle, maxChars: 24 },
    ...(kitPath ? { kit: { path: kitPath } } : {}),
  };
}

describe('buildMotionAss', () => {
  it('a motion-less project produces no ASS document at all (ass: null)', () => {
    const res = buildMotionAss(manifest([]), {}, null, OUT);
    expect(res).toEqual({ ass: null, customHtmlSkipped: 0 });
  });

  it('a project whose only motion item has NO resolved sidecar (missing from motionSpecs) is silently skipped, same as a motion-less project', () => {
    const m = manifest([motionItem({ id: 'm1', tlStart: 0, duration: 3 })]);
    const res = buildMotionAss(m, {}, null, OUT);
    expect(res.ass).toBeNull();
  });

  it('a project with only custom-html motion produces ass:null but a non-zero customHtmlSkipped count', () => {
    const m = manifest([motionItem({ id: 'm1', tlStart: 0, duration: 3 })]);
    const res = buildMotionAss(m, { m1: spec('custom-html', {}) }, null, OUT);
    expect(res.ass).toBeNull();
    expect(res.customHtmlSkipped).toBe(1);
  });

  it('emits a well-formed .ass document: Script Info header, one shared "motion" style, and one Dialogue block per item', () => {
    const m = manifest([motionItem({ id: 'm1', tlStart: 1, duration: 2 })]);
    const res = buildMotionAss(m, { m1: spec('cta', { text: 'Hi' }) }, null, OUT);
    expect(res.ass).not.toBeNull();
    expect(res.ass).toContain('[Script Info]');
    expect(res.ass).toContain(`PlayResX: ${OUT.width}`);
    expect(res.ass).toContain(`PlayResY: ${OUT.height}`);
    expect(res.ass).toMatch(/^Style: motion,/m);
    expect(res.ass).toContain('[Events]');
    expect(res.ass).toMatch(/^Dialogue: 0,0:00:01\.00,0:00:03\.00,motion,,/m);
  });

  it('resolves the default accent from the kit style matching m.captions.style (same lookup toAss uses)', () => {
    const kit: KitFile = { version: 'vedit-kit/v1', styles: [{ id: 'kitStyle1', palette: { accent: '#00ff00' } }] };
    const m = manifest([motionItem({ id: 'm1', tlStart: 0, duration: 2 })], 'kitStyle1');
    const withKit = buildMotionAss(m, { m1: spec('cta', { text: 'x' }) }, kit, OUT);
    const withoutKit = buildMotionAss(m, { m1: spec('cta', { text: 'x' }) }, null, OUT);
    expect(withKit.ass).toContain('\\3c&H00FF00&'); // kit accent (BGR of #00ff00 is palindromic)
    expect(withoutKit.ass).not.toContain('\\3c&H00FF00&');
  });

  it("a kit whose active style has no palette.accent falls back to the web's #4b9fff default", () => {
    const kit: KitFile = { version: 'vedit-kit/v1', styles: [{ id: 'kitStyle1', palette: { text: '#ffffff' } }] };
    const m = manifest([motionItem({ id: 'm1', tlStart: 0, duration: 2 })], 'kitStyle1');
    const res = buildMotionAss(m, { m1: spec('cta', { text: 'x' }) }, kit, OUT);
    expect(res.ass).toContain('\\3c&HFF9F4B&'); // #4b9fff -> BGR FF9F4B
  });

  it("a per-item params.palette still beats the kit's default accent", () => {
    const kit: KitFile = { version: 'vedit-kit/v1', styles: [{ id: 'kitStyle1', palette: { accent: '#00ff00' } }] };
    const m = manifest([motionItem({ id: 'm1', tlStart: 0, duration: 2 })], 'kitStyle1');
    const res = buildMotionAss(m, { m1: spec('cta', { text: 'x', palette: '#ff0000' }) }, kit, OUT);
    expect(res.ass).toContain('\\3c&H0000FF&'); // #ff0000 -> BGR 0000FF
    expect(res.ass).not.toContain('\\3c&H00FF00&');
  });

  it('a kit with no style matching captions.style falls back to the default accent exactly like passing no kit', () => {
    const kit: KitFile = { version: 'vedit-kit/v1', styles: [{ id: 'unrelatedStyle', palette: { accent: '#00ff00' } }] };
    const m = manifest([motionItem({ id: 'm1', tlStart: 0, duration: 2 })], 'clean');
    const withUnrelatedKit = buildMotionAss(m, { m1: spec('cta', { text: 'x' }) }, kit, OUT);
    const withoutKit = buildMotionAss(m, { m1: spec('cta', { text: 'x' }) }, null, OUT);
    expect(withUnrelatedKit.ass).toBe(withoutKit.ass);
  });
});
