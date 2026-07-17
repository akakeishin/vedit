// W7 "モーションの最終レンダー焼き込み": burns the 4 built-in MotionItem
// presets (chapter-card / lower-third / callout / cta) into the final
// render as a SECOND ASS document + a second `ass` ffmpeg filter, applied
// alongside (not merged into) toAss()'s caption/dialogue ASS in render.ts.
//
// Why a separate document rather than folding into toAss(): captions and
// dialogue are each gated by their own condition (opts.burnCaptions &&
// captions.enabled; m.timeline.dialogue.length>0) and use their OWN shared
// style ids/colours per m.captions.style — motion is a THIRD, independent
// track that must burn regardless of caption settings (a project can have
// captions disabled yet still want its chapter cards burned in). Keeping it
// in its own document/style namespace means it can never collide with a kit
// style id, never perturbs toAss()'s golden output, and the two `ass`
// filters can be ordered independently to match the web preview's DOM
// stacking (#captionLayer, then #motionLayer, then #dialogueLayer — see
// web/index.html) — motion draws OVER captions but UNDER dialogue bubbles.
//
// custom-html motion items are NEVER burned (out of scope for W7 — arbitrary
// HTML has no ASS equivalent); they're only counted so the caller can warn
// "custom-html は焼き込み対象外(N件)".
//
// Visual basis: web/app.js's renderMotion/motionNode + the .mo-* rules in
// web/style.css (lines ~156-187) are the ground truth this module
// approximates — see each preset's builder below for the exact CSS rule it
// mirrors. Per the sprite-motion precedent elsewhere in this codebase, the
// contract is "見た目近似で可、タイミング(開始/終了秒)は厳密一致": every
// emitted Dialogue's Start/End come directly from MotionItem.tlStart/
// duration, unrounded in time (only pixel geometry is rounded).

import type { KitFile, KitStyle, Manifest, MotionItem, MotionSpec } from '../core/types.js';

/** MotionSpec.type values this module knows how to burn in. custom-html is deliberately excluded — see module doc. */
const BURNABLE_TYPES = new Set(['chapter-card', 'lower-third', 'callout', 'cta']);

/** Matches web/style.css's `:root { --accent: #4b9fff; }` — the fallback when neither a MotionSpec.params.palette override nor a linked kit style's palette.accent is available. */
const DEFAULT_ACCENT_HEX = '#4b9fff';

/** ASS style name shared by every burned motion event (per-event override tags carry all the actual per-preset styling — same pattern render.ts's toAss uses for DIALOGUE_STYLE_NAME). */
const MOTION_STYLE_NAME = 'motion';

export interface MotionBurnInput {
  item: MotionItem;
  spec: MotionSpec;
}

export interface MotionAssLinesResult {
  /** ASS `Dialogue:` event lines (Events section body only — no header). */
  lines: string[];
  /** Count of `custom-html` items present in the input that were excluded from burn-in. */
  customHtmlSkipped: number;
}

export interface MotionAssDocument {
  /** A full standalone .ass document (Script Info + [V4+ Styles] + [Events]), or null when there is nothing burnable at all (so the caller can skip writing/applying a second `ass` filter entirely — full regression for motion-less/custom-html-only projects). */
  ass: string | null;
  customHtmlSkipped: number;
}

// ---- small pure colour helpers (deliberately duplicated from render.ts's
// hexToBgr/opacityToAlphaHex rather than imported — render.ts imports THIS
// module for buildMotionAss, so importing back would be circular; both
// helpers are ~5 lines and have no state) ----

/** "#RRGGBB"/"#RGB" -> ASS's BBGGRR hex (no leading &H/alpha). Garbage input falls back to white. */
function hexToBgr(hex: string): string {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return 'FFFFFF';
  return (h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2)).toUpperCase();
}
/** 0..1 opacity -> ASS alpha hex (00 = opaque, FF = fully transparent). */
function alphaHexFromOpacity(opacity: number): string {
  const a = Math.round((1 - Math.max(0, Math.min(1, opacity))) * 255);
  return a.toString(16).toUpperCase().padStart(2, '0');
}
/** Inline override tag for ASS colour slot `n` (1=primary/text, 3=outline — which BorderStyle=3 renders as the box fill). */
function colorTag(n: 1 | 3, hex: string, opacity = 1): string {
  return `\\${n}c&H${hexToBgr(hex)}&\\${n}a&H${alphaHexFromOpacity(opacity)}&`;
}
/** Escape ASS override-tag metacharacters and turn newlines into `\N` (ASS's literal-newline tag) — mirrors web/app.js's `esc()` but for ASS syntax instead of HTML. */
function assEscapeText(s: string): string {
  return String(s).replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, '\\N');
}
function assTime(t: number): string {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${s}`;
}
/** Entry-animation duration, clamped so `\fad`/`\move`/`\t` never outlast the item's own on-screen window. */
function clampFadeMs(preferredMs: number, durationSeconds: number): number {
  return Math.max(0, Math.min(preferredMs, Math.round(durationSeconds * 1000)));
}
/** `MotionSpec.params.palette` (a per-item hex override, same field `vedit motion-add --palette` writes and web's motionNode reads for `--accent`) beats the resolved kit/default accent. */
function motionAccentHex(spec: MotionSpec, defaultAccentHex: string): string {
  const p = spec.params ?? {};
  const palette = p.palette;
  return typeof palette === 'string' && palette.trim() ? palette.trim() : defaultAccentHex;
}
function textParam(spec: MotionSpec, key: 'text' | 'subtitle'): string | undefined {
  const v = (spec.params ?? {})[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// ---- preset builders — each returns the ASS Dialogue: line(s) for one MotionItem ----

/**
 * .mo-chapter-card (web/style.css:157-165): full-frame overlay, a dark
 * gradient wash, a centered white title (letter-spaced), a thin accent bar,
 * and an optional subtitle — entry is a plain 0.5s fade (moFade), no
 * movement. The gradient has no ASS equivalent (drawings fill flat, not
 * gradient) so it's approximated with a flat mid-tone fill averaging the two
 * gradient stops (rgba(10,14,22)/rgba(20,30,50) @ 0.88 opacity each).
 */
function chapterCardLines(item: MotionItem, spec: MotionSpec, output: { width: number; height: number }, accentHex: string): string[] {
  const { width: W, height: H } = output;
  const start = assTime(item.tlStart);
  const end = assTime(item.tlStart + item.duration);
  const fadeMs = clampFadeMs(500, item.duration);
  const text = textParam(spec, 'text') ?? '';
  const subtitle = textParam(spec, 'subtitle');

  const titleSize = Math.round(H * 0.05); // css: clamp(22px,5vw,54px) -> 54/1080 at a standard 16:9 canvas
  const subSize = Math.round(H * 0.0185); // css: clamp(12px,2vw,20px) -> 20/1080
  const letterSpacing = Math.round(titleSize * 0.06); // css: letter-spacing: 0.06em
  const barW = titleSize * 3; // css: .bar { width: 3em }
  const barH = Math.max(2, Math.round(H * 0.0028)); // css: .bar { height: 3px } -> 3/1080
  const gap = Math.round(titleSize * 0.35); // css: flex column `gap: 0.4em` (approximated against title's em)

  let blockH = titleSize + gap + barH;
  if (subtitle) blockH += gap + subSize;
  let cursorY = H / 2 - blockH / 2;
  const titleY = cursorY + titleSize / 2;
  cursorY += titleSize + gap;
  const barY = cursorY + barH / 2;
  cursorY += barH + gap;
  const subY = subtitle ? cursorY + subSize / 2 : 0;

  const fad = `\\fad(${fadeMs},0)`;
  const lines: string[] = [];
  // Full-frame background wash (drawing, top-left anchored so the drawn
  // rectangle's own (0,0)-(W,H) coordinates map straight onto the frame).
  lines.push(
    `Dialogue: 0,${start},${end},${MOTION_STYLE_NAME},,0,0,0,,` +
      `{\\an7\\pos(0,0)\\bord0\\shad0${colorTag(1, '#0f1624', 0.88)}${fad}\\p1}m 0 0 l ${W} 0 l ${W} ${H} l 0 ${H}{\\p0}`,
  );
  lines.push(
    `Dialogue: 0,${start},${end},${MOTION_STYLE_NAME},,0,0,0,,` +
      `{\\an5\\pos(${Math.round(W / 2)},${Math.round(titleY)})\\bord0\\shad0\\fs${titleSize}\\fsp${letterSpacing}${colorTag(1, '#ffffff')}${fad}}${assEscapeText(text)}`,
  );
  lines.push(
    `Dialogue: 0,${start},${end},${MOTION_STYLE_NAME},,0,0,0,,` +
      `{\\an7\\pos(${Math.round(W / 2 - barW / 2)},${Math.round(barY - barH / 2)})\\bord0\\shad0${colorTag(1, accentHex)}${fad}\\p1}m 0 0 l ${barW} 0 l ${barW} ${barH} l 0 ${barH}{\\p0}`,
  );
  if (subtitle) {
    lines.push(
      `Dialogue: 0,${start},${end},${MOTION_STYLE_NAME},,0,0,0,,` +
        `{\\an5\\pos(${Math.round(W / 2)},${Math.round(subY)})\\bord0\\shad0\\fs${subSize}${colorTag(1, '#9fb6d4')}${fad}}${assEscapeText(subtitle)}`,
    );
  }
  return lines;
}

/**
 * .mo-lower-third (web/style.css:166-172): a box anchored `left:5%;
 * bottom:12%` with a 4px accent left-border, white title + gray subtitle
 * stacked inside, `padding: 0.4em 1em`. Entry is a 0.4s slide-in-from-left
 * (translateX(-14px) -> 0) + fade (moSlide). The box itself is a
 * BorderStyle=3 auto-fit box (same technique render.ts already uses for
 * kitAssStyle/speechBubbleAssStyle) rather than a hand-measured rectangle —
 * libass sizes it to the actual text, so it adapts to any text length/script
 * the same way the CSS inline-block-with-padding box does. The accent
 * left-border is a second, separately drawn/moved thin rectangle layered on
 * top so it reads as a stripe rather than a whole-box tint.
 */
function lowerThirdLines(item: MotionItem, spec: MotionSpec, output: { width: number; height: number }, accentHex: string): string[] {
  const { width: W, height: H } = output;
  const start = assTime(item.tlStart);
  const end = assTime(item.tlStart + item.duration);
  const fadeMs = clampFadeMs(400, item.duration);
  const text = textParam(spec, 'text') ?? '';
  const subtitle = textParam(spec, 'subtitle');

  const titleSize = Math.round(H * 0.024); // css: clamp(14px,2.4vw,26px) -> 26/1080
  const subSize = Math.round(H * 0.0148); // css: clamp(11px,1.6vw,16px) -> 16/1080
  const pad = Math.round(titleSize * 0.6); // css: padding: 0.4em 1em (uniform ASS \bord approximation)
  const lineH = (fs: number) => Math.round(fs * 1.3);
  const textBlockH = subtitle ? lineH(titleSize) + lineH(subSize) : lineH(titleSize);

  const boxLeft = W * 0.05; // css: left: 5%
  const boxBottom = H * 0.88; // css: bottom: 12% -> distance from top = 100%-12%
  // an1 (bottom-left) anchors the TEXT bbox; BorderStyle=3's box grows
  // outward by `pad` on every side, so offset the text anchor inward by
  // `pad` to land the visible box's own bottom-left corner on the CSS target.
  const textX = boxLeft + pad;
  const textY = boxBottom - pad;
  const startTextX = textX - 14; // css: translateX(-14px) initial offset

  const bgHex = '#080a0e'; // css: rgba(8,10,14,...)
  const bgOpacity = 0.78;

  let text2 = assEscapeText(text);
  if (subtitle) {
    text2 += `{\\N\\fs${subSize}${colorTag(1, '#a9b4c2')}}${assEscapeText(subtitle)}`;
  }
  const lines: string[] = [];
  lines.push(
    `Dialogue: 0,${start},${end},${MOTION_STYLE_NAME},,0,0,0,,` +
      `{\\an1\\pos(${Math.round(textX)},${Math.round(textY)})\\move(${Math.round(startTextX)},${Math.round(textY)},${Math.round(textX)},${Math.round(textY)},0,${fadeMs})` +
      `\\bord${pad}\\shad0${colorTag(3, bgHex, bgOpacity)}\\fs${titleSize}${colorTag(1, '#ffffff')}\\fad(${fadeMs},0)}${text2}`,
  );
  // Accent left-border stripe, drawn AFTER the box so it sits on top of the box's own fill.
  const stripeW = Math.max(2, Math.round(H * 0.0037)); // css: border-left: 4px -> 4/1080
  const stripeH = textBlockH + pad * 2;
  const stripeX = boxLeft;
  const stripeY = boxBottom - stripeH;
  const startStripeX = stripeX - 14;
  lines.push(
    `Dialogue: 0,${start},${end},${MOTION_STYLE_NAME},,0,0,0,,` +
      `{\\an7\\pos(${Math.round(startStripeX)},${Math.round(stripeY)})\\move(${Math.round(startStripeX)},${Math.round(stripeY)},${Math.round(stripeX)},${Math.round(stripeY)},0,${fadeMs})` +
      `\\bord0\\shad0${colorTag(1, accentHex)}\\fad(${fadeMs},0)\\p1}m 0 0 l ${stripeW} 0 l ${stripeW} ${Math.round(stripeH)} l 0 ${Math.round(stripeH)}{\\p0}`,
  );
  return lines;
}

/**
 * .mo-callout (web/style.css:173-178): a box anchored `top:12%; right:6%`,
 * bold white text, `border: 2px solid var(--accent)` over a
 * `rgba(8,10,14,0.8)` fill, `border-radius: 10px`, entry is a 0.35s
 * scale-pop (0.8 -> 1) + fade (moPop, cubic-bezier bounce). ASS's
 * BorderStyle=3 box has no distinct border-colour-vs-fill-colour (only one
 * fill) and no corner radius, so this is approximated as a single
 * accent-tinted box (KNOWN DIFFERENCE from web: the dark fill + thin accent
 * ring reads as a solid accent-tinted box instead; corners are square, not
 * rounded — see dialogueAssLines's own doc comment for the same rounded-
 * corner caveat on speech bubbles).
 */
function calloutLines(item: MotionItem, spec: MotionSpec, output: { width: number; height: number }, accentHex: string): string[] {
  const { width: W, height: H } = output;
  const start = assTime(item.tlStart);
  const end = assTime(item.tlStart + item.duration);
  const fadeMs = clampFadeMs(350, item.duration);
  const text = textParam(spec, 'text') ?? '';

  const fs = Math.round(H * 0.0204); // css: clamp(13px,2vw,22px) -> 22/1080
  const pad = Math.round(fs * 0.55); // css: padding: 0.5em 1em
  const x = W * (1 - 0.06); // css: right: 6%
  const y = H * 0.12; // css: top: 12%

  const lines: string[] = [];
  lines.push(
    `Dialogue: 0,${start},${end},${MOTION_STYLE_NAME},,0,0,0,,` +
      `{\\an9\\pos(${Math.round(x)},${Math.round(y)})\\bord${pad}\\shad0${colorTag(3, accentHex, 0.85)}\\b1\\fs${fs}${colorTag(1, '#ffffff')}` +
      `\\fscx80\\fscy80\\t(0,${fadeMs},\\fscx100\\fscy100)\\fad(${fadeMs},0)}${assEscapeText(text)}`,
  );
  return lines;
}

/**
 * .mo-cta (web/style.css:179-183): a solid accent pill anchored
 * `left:50%; bottom:8%` (translateX(-50%) is pure centering, reproduced
 * directly via ASS's an2/bottom-center alignment rather than emulated), dark
 * navy bold text, entry is the same 0.35s scale-pop as callout (moPop, ease
 * this time rather than a bounce — ASS's linear `\t` doesn't distinguish
 * easing curves either way, so both presets share the same interpolation).
 * `border-radius: 999px` (a true pill) has no ASS equivalent — burns as a
 * square-cornered box (documented known difference).
 */
function ctaLines(item: MotionItem, spec: MotionSpec, output: { width: number; height: number }, accentHex: string): string[] {
  const { width: W, height: H } = output;
  const start = assTime(item.tlStart);
  const end = assTime(item.tlStart + item.duration);
  const fadeMs = clampFadeMs(350, item.duration);
  const text = textParam(spec, 'text') ?? '';

  const fs = Math.round(H * 0.0222); // css: clamp(13px,2.2vw,24px) -> 24/1080
  const pad = Math.round(fs * 0.55); // css: padding: 0.5em 1.4em
  const x = W * 0.5; // css: left: 50% (+ translateX(-50%) centering)
  const y = H * (1 - 0.08); // css: bottom: 8%

  const lines: string[] = [];
  lines.push(
    `Dialogue: 0,${start},${end},${MOTION_STYLE_NAME},,0,0,0,,` +
      `{\\an2\\pos(${Math.round(x)},${Math.round(y)})\\bord${pad}\\shad0${colorTag(3, accentHex, 1)}\\b1\\fs${fs}${colorTag(1, '#04101f')}` +
      `\\fscx80\\fscy80\\t(0,${fadeMs},\\fscx100\\fscy100)\\fad(${fadeMs},0)}${assEscapeText(text)}`,
  );
  return lines;
}

/**
 * `MotionItem`+`MotionSpec` pairs -> ASS `Dialogue:` event lines for the 4
 * built-in presets, pure/I-O-free (the caller resolves each item's spec
 * sidecar and passes it in — see buildMotionAss below, and web/app.js's own
 * loadMotionSpecs for the same "resolve specs, then render" split).
 * `custom-html` items are counted but never emitted.
 */
export function motionAssLines(
  items: MotionBurnInput[],
  output: { width: number; height: number },
  defaultAccentHex: string,
): MotionAssLinesResult {
  const lines: string[] = [];
  let customHtmlSkipped = 0;
  for (const { item, spec } of items) {
    if (spec.type === 'custom-html') {
      customHtmlSkipped++;
      continue;
    }
    if (!BURNABLE_TYPES.has(spec.type)) continue; // unrecognized/future type — not one of the 4 presets, skip silently
    const accentHex = motionAccentHex(spec, defaultAccentHex);
    if (spec.type === 'chapter-card') lines.push(...chapterCardLines(item, spec, output, accentHex));
    else if (spec.type === 'lower-third') lines.push(...lowerThirdLines(item, spec, output, accentHex));
    else if (spec.type === 'callout') lines.push(...calloutLines(item, spec, output, accentHex));
    else if (spec.type === 'cta') lines.push(...ctaLines(item, spec, output, accentHex));
  }
  return { lines, customHtmlSkipped };
}

/**
 * Manifest + resolved motion sidecars -> a full standalone .ass document, or
 * `{ ass: null, ... }` when nothing is burnable (motion-less project, or a
 * project whose only motion items are custom-html/unresolved) — the caller
 * (render.ts's renderFinal/renderComposition) then skips applying a second
 * `ass` filter entirely, which is what keeps a motion-less render's
 * filtergraph byte-for-byte unchanged.
 *
 * `motionSpecs` is caller-supplied already-loaded sidecar content, keyed by
 * MotionItem.id — mirrors buildFilterGraph's `kitAssets` convention. render.ts
 * has no way to locate `motion/<id>.json` sidecars itself (Manifest carries
 * no project-directory reference), so this stays pure/I-O-free like the rest
 * of the module; loading is the caller's job (see core/project.ts's
 * Project.readMotionSpec).
 *
 * `kit`'s active style — resolved the SAME way toAss()/kitAssStyle already do
 * (kit.styles.find(s => s.id === m.captions.style)) — supplies the default
 * accent color via its `palette.accent`, reusing render.ts's existing kit
 * style resolution per the W7 spec's "キット統合" requirement. A MotionSpec's
 * own `params.palette` (set via `vedit motion-add --palette`) always wins
 * over the kit default, matching web's motionNode (`if (p.palette) d.style.
 * setProperty('--accent', p.palette)`).
 */
export function buildMotionAss(
  m: Manifest,
  motionSpecs: Record<string, MotionSpec>,
  kit: KitFile | null | undefined,
  output: { width: number; height: number },
): MotionAssDocument {
  const activeKitStyle: KitStyle | undefined = kit?.styles?.find((s) => s.id === m.captions.style);
  const defaultAccentHex = activeKitStyle?.palette?.accent || DEFAULT_ACCENT_HEX;

  const items: MotionBurnInput[] = [];
  for (const mi of m.timeline.motion) {
    const spec = motionSpecs[mi.id];
    if (spec) items.push({ item: mi, spec });
  }

  const { lines, customHtmlSkipped } = motionAssLines(items, output, defaultAccentHex);
  if (lines.length === 0) return { ass: null, customHtmlSkipped };

  // BorderStyle=3 base (auto-fit box for lower-third/callout/cta; \bord0
  // per-event disables it for chapter-card's plain text/drawings) — every
  // other style field is irrelevant since each event overrides colour/size/
  // position/alignment itself (same "one shared style, everything inline"
  // pattern toAss uses for DIALOGUE_STYLE_NAME).
  const styleLine = `Style: ${MOTION_STYLE_NAME},Hiragino Sans,${Math.round(output.height * 0.03)},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,0,0,5,0,0,0,1`;
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${output.width}
PlayResY: ${output.height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleLine}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  return { ass: head + lines.join('\n') + '\n', customHtmlSkipped };
}
