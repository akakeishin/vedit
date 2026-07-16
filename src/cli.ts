#!/usr/bin/env node
import path from 'node:path';
import { promises as fs, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon } from './server/daemon.js';
import { Project } from './core/project.js';
import { renderView } from './export/view.js';
import { writeOtio } from './export/otio.js';
import { renderFinal } from './export/render.js';
import { downloadWhisperModel, findWhisperModel } from './ingest/ingest.js';
import { ffmpegBin, ffmpegHasFilter, run } from './ingest/run.js';
import type { Transcript } from './core/types.js';

const PORT = Number(process.env.VEDIT_PORT ?? 7799);
const BASE = `http://localhost:${PORT}`;

// ---- tiny arg parsing ----
const argv = process.argv.slice(2);
const cmd = argv[0];
const flags: Record<string, string | boolean> = {};
const pos: string[] = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
    else flags[a.slice(2)] = true;
  } else pos.push(a);
}

function out(obj: unknown) {
  console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1));
}

function fail(msg: string): never {
  console.error(JSON.stringify({ error: msg }));
  process.exit(1);
}

function projectDir(): string {
  const dir = (flags.project as string) ?? process.env.VEDIT_PROJECT ?? process.cwd();
  const abs = path.resolve(dir);
  if (!existsSync(path.join(abs, 'project.json'))) {
    fail(`no project.json in ${abs}. Use --project <dir> or run \`vedit create <dir>\` first.`);
  }
  return abs;
}

// ---- daemon client ----
async function api(pathname: string, init?: RequestInit): Promise<any> {
  const res = await fetch(BASE + pathname, init);
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = body?.error ?? text;
    if (res.status === 409) fail(`REJECTED (stale revision): ${msg}`);
    fail(msg);
  }
  return body;
}

async function daemonUp(): Promise<boolean> {
  try {
    await fetch(BASE + '/api/ping', { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

async function ensureDaemon(dir?: string): Promise<void> {
  if (!(await daemonUp())) {
    const self = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [self, 'serve', ...(dir ? ['--project', dir] : [])], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await daemonUp()) break;
    }
    if (!(await daemonUp())) fail('failed to start vedit daemon');
  }
  if (dir) await api('/api/open', { method: 'POST', body: JSON.stringify({ dir }) });
}

function baseRevOf(state: any): number {
  if (flags.base !== undefined) return Number(flags.base);
  if (flags.latest) return Number(state.revision);
  fail('--base <revision> is required (or --latest to explicitly use the current one); run `vedit status` first');
}

async function edit(body: Record<string, unknown>) {
  const dir = projectDir();
  await ensureDaemon(dir);
  const state = await api('/api/state');
  const res = await api('/api/edit', {
    method: 'POST',
    body: JSON.stringify({ baseRev: baseRevOf(state), actor: flags.actor ?? 'claude', ...body }),
  });
  out({ ...res, hint: 'preview updated live; use `vedit view` to inspect, `vedit undo` to revert' });
}

const HELP = `vedit — conversational local NLE

usage: vedit <command> [args] [--project <dir>]

project:   create <dir> [--name n] | status | revisions | undo [--rev N] | open
ingest:    ingest <file...> [--language ja] [--no-transcribe]
read:      transcript [--full] [--source id] | candidates [--all]
detect:    detect [--min-gap 0.7] [--threshold 0.06] [--no-fillers] [--no-silence]
cut:       remove-words <w1 w5..w9 ...> [--source id] [--pad 0.08] | remove-range <t0> <t1> [--source id]
           approve <id...|all> | reject <id...> | trim <clipId> <in|out> <±frames>
captions:  captions [--enabled true|false] [--style clean|bold] [--max-chars 24]
motion:    motion-add --type chapter-card --text "..." --at 12 --duration 4 [--subtitle ...]
           motion-update <id> [--text ...] [--at ...] [--duration ...] | motion-remove <id>
inspect:   view [--from a] [--to b] [--domain timeline|source] [--source id] (prints PNG path)
export:    export otio <out.otio> | export render <out.mp4> [--burn-captions] | export fcp7xml <out.xml>
misc:      doctor [--download-model [name]] | serve [--port]

Mutating commands REQUIRE --base <rev> (or --latest to explicitly use the
current one); if the project changed since that revision the edit is
REJECTED (409) — re-read state first.`;

async function main() {
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
      return out(HELP);

    case 'serve': {
      const dir = (flags.project as string) ? path.resolve(flags.project as string) : undefined;
      const { url } = await startDaemon({ port: Number(flags.port ?? PORT), projectDir: dir });
      console.log(`vedit daemon on ${url}${dir ? ` (project: ${dir})` : ''}`);
      return; // keeps running
    }

    case 'create': {
      const dir = path.resolve(pos[0] ?? fail('usage: vedit create <dir>'));
      await Project.create(dir, (flags.name as string) ?? path.basename(dir));
      await ensureDaemon(dir);
      return out({ ok: true, dir, next: `vedit ingest <video> --project ${dir}` });
    }

    case 'open': {
      const dir = projectDir();
      await ensureDaemon(dir);
      return out({ url: BASE, hint: 'open this URL in a browser (or Claude browser pane) for live preview' });
    }

    case 'status': {
      const dir = projectDir();
      await ensureDaemon(dir);
      const state = await api('/api/state');
      return out({ ...state, previewUrl: BASE, hint: 'pass --base ' + state.revision + ' to mutating commands' });
    }

    case 'ingest': {
      const dir = projectDir();
      await ensureDaemon(dir);
      if (pos.length === 0) fail('usage: vedit ingest <file...>');
      for (const f of pos) {
        console.error(`ingesting ${f} (proxy + waveform + transcription; this can take a while)...`);
        const res = await api('/api/ingest', {
          method: 'POST',
          body: JSON.stringify({
            file: path.resolve(f),
            language: flags.language,
            transcribe: flags['no-transcribe'] ? false : undefined,
          }),
        });
        out(res);
      }
      return;
    }

    case 'transcript': {
      const dir = projectDir();
      await ensureDaemon(dir);
      const q = new URLSearchParams();
      if (flags.full) q.set('full', '1');
      if (flags.source) q.set('source', String(flags.source));
      const res = await fetch(`${BASE}/api/transcript?${q}`);
      if (!res.ok) fail(await res.text());
      return console.log(await res.text());
    }

    case 'detect': {
      const dir = projectDir();
      await ensureDaemon(dir);
      const res = await api('/api/detect', {
        method: 'POST',
        body: JSON.stringify({
          minGap: flags['min-gap'] ? Number(flags['min-gap']) : undefined,
          threshold: flags.threshold ? Number(flags.threshold) : undefined,
          fillers: flags['no-fillers'] ? false : undefined,
          silence: flags['no-silence'] ? false : undefined,
        }),
      });
      return out(res);
    }

    case 'candidates': {
      const dir = projectDir();
      await ensureDaemon(dir);
      return out(await api(`/api/candidates${flags.all ? '?all=1' : ''}`));
    }

    case 'approve':
    case 'reject': {
      const dir = projectDir();
      await ensureDaemon(dir);
      const state = await api('/api/state');
      const ids = pos[0] === 'all' ? 'all' : pos;
      if (!ids || (Array.isArray(ids) && ids.length === 0)) fail(`usage: vedit ${cmd} <candidateId...|all>`);
      const res = await api('/api/candidates/decide', {
        method: 'POST',
        body: JSON.stringify({ ids, decision: cmd === 'approve' ? 'approve' : 'reject', actor: flags.actor ?? 'claude', baseRev: baseRevOf(state) }),
      });
      return out(res);
    }

    case 'remove-words':
      if (pos.length === 0) fail('usage: vedit remove-words <w12 w40..w52 ...>');
      return edit({ op: 'remove-words', ids: pos, sourceId: flags.source, pad: flags.pad !== undefined ? Number(flags.pad) : undefined });

    case 'remove-range':
      if (pos.length < 2) fail('usage: vedit remove-range <t0> <t1>');
      return edit({ op: 'remove-range', t0: Number(pos[0]), t1: Number(pos[1]), sourceId: flags.source });

    case 'trim':
      if (pos.length < 3) fail('usage: vedit trim <clipId> <in|out> <±frames>');
      return edit({ op: 'trim', clipId: pos[0], edge: pos[1], frames: Number(pos[2]) });

    case 'captions': {
      const patch: Record<string, unknown> = {};
      if (flags.enabled !== undefined) patch.enabled = flags.enabled === 'true' || flags.enabled === true;
      if (flags.style) patch.style = flags.style;
      if (flags['max-chars']) patch.maxChars = Number(flags['max-chars']);
      if (Object.keys(patch).length === 0) {
        const dir = projectDir();
        await ensureDaemon(dir);
        return out(await api('/api/captions'));
      }
      return edit({ op: 'captions', patch });
    }

    case 'motion-add': {
      const type = (flags.type as string) ?? 'chapter-card';
      const params: Record<string, unknown> = {};
      for (const k of ['text', 'subtitle', 'palette', 'position', 'animation']) if (flags[k]) params[k] = flags[k];
      return edit({
        op: 'motion-add',
        spec: { type, params, html: flags.html },
        tlStart: Number(flags.at ?? 0),
        duration: Number(flags.duration ?? 4),
      });
    }
    case 'motion-update': {
      const params: Record<string, unknown> = {};
      for (const k of ['text', 'subtitle', 'palette', 'position', 'animation']) if (flags[k]) params[k] = flags[k];
      return edit({
        op: 'motion-update',
        id: pos[0] ?? fail('usage: vedit motion-update <id> [--text ...]'),
        spec: Object.keys(params).length ? { params } : undefined,
        tlStart: flags.at !== undefined ? Number(flags.at) : undefined,
        duration: flags.duration !== undefined ? Number(flags.duration) : undefined,
      });
    }
    case 'motion-remove':
      return edit({ op: 'motion-remove', id: pos[0] ?? fail('usage: vedit motion-remove <id>') });

    case 'undo': {
      const dir = projectDir();
      await ensureDaemon(dir);
      const revs = await api('/api/revisions');
      const target = flags.rev ? Number(flags.rev) : Math.max(1, (revs.at(-1)?.rev ?? 1) - 1);
      return edit({ op: 'restore', rev: target });
    }

    case 'revisions': {
      const dir = projectDir();
      await ensureDaemon(dir);
      const revs = await api('/api/revisions');
      return out(revs.map((r: any) => `r${r.rev} [${r.actor}] ${r.op}: ${r.summary}`).join('\n'));
    }

    case 'view': {
      const dir = projectDir();
      const p = await Project.open(dir);
      const m = await p.manifest();
      const v = await renderView(m, dir, {
        domain: (flags.domain as 'timeline' | 'source') ?? 'timeline',
        sourceId: flags.source as string,
        from: flags.from !== undefined ? Number(flags.from) : undefined,
        to: flags.to !== undefined ? Number(flags.to) : undefined,
        cols: flags.cols ? Number(flags.cols) : undefined,
        rows: flags.rows ? Number(flags.rows) : undefined,
      });
      return out({ ...v, hint: 'Read the png to inspect frames; grid maps cells to source times' });
    }

    case 'export': {
      const dir = projectDir();
      const p = await Project.open(dir);
      const m = await p.manifest();
      const kind = pos[0];
      const dest = pos[1] ?? fail('usage: vedit export <otio|render|fcp7xml> <outfile>');
      if (kind === 'otio') {
        await writeOtio(m, path.resolve(dest));
        return out({ ok: true, file: dest, hint: 'DaVinci Resolve: File > Import > Timeline (18.5+, free version OK)' });
      }
      if (kind === 'render') {
        const transcripts: Transcript[] = [];
        for (const s of m.sources) if (s.transcribed) transcripts.push(await p.transcript(s.id));
        console.error('rendering from original sources (this encodes the full timeline)...');
        await renderFinal(m, transcripts, path.resolve(dest), { burnCaptions: Boolean(flags['burn-captions']) });
        return out({ ok: true, file: dest });
      }
      if (kind === 'fcp7xml') {
        const otioTmp = path.resolve(dest) + '.otio';
        await writeOtio(m, otioTmp);
        try {
          await run('uvx', ['--from', 'opentimelineio', '--with', 'otio-fcp-adapter', 'otioconvert', '-i', otioTmp, '-o', path.resolve(dest)]);
        } catch (e: any) {
          fail(`fcp7xml conversion failed (needs uv + python): ${e.message}\nThe .otio file was written to ${otioTmp}; Resolve can import it directly.`);
        }
        await fs.rm(otioTmp, { force: true });
        return out({ ok: true, file: dest, hint: 'Premiere: File > Import (FCP7 XML)' });
      }
      fail(`unknown export kind: ${kind}`);
      return;
    }

    case 'doctor': {
      const checks: Record<string, string> = {};
      for (const [bin, args] of [
        ['ffmpeg', ['-version']],
        ['ffprobe', ['-version']],
        ['whisper-cli', ['--help']],
      ] as const) {
        try {
          const o = await run(bin, args as unknown as string[]);
          checks[bin] = 'ok ' + (o.split('\n')[0]?.slice(0, 60) ?? '');
        } catch (e: any) {
          checks[bin] = 'MISSING — ' + (bin === 'whisper-cli' ? 'brew install whisper-cpp' : `brew install ${bin === 'ffprobe' ? 'ffmpeg' : bin}`);
        }
      }
      checks['ffmpeg (resolved)'] = `${ffmpegBin()} — drawtext:${ffmpegHasFilter('drawtext') ? 'ok' : 'NO (view timecodes off)'} ass:${ffmpegHasFilter('ass') ? 'ok' : 'NO (caption burn off; brew install ffmpeg-full)'}`;
      let model = await findWhisperModel();
      if (flags['download-model']) {
        const name = typeof flags['download-model'] === 'string' ? (flags['download-model'] as string) : 'ggml-large-v3-turbo';
        console.error(`downloading ${name} ...`);
        model = await downloadWhisperModel(name);
      }
      checks['whisper model'] = model ?? 'MISSING — run `vedit doctor --download-model` (large-v3-turbo, ~1.6GB) or --download-model ggml-small (~470MB)';
      try {
        await run('uvx', ['--version']);
        checks['uv (for fcp7xml export)'] = 'ok';
      } catch {
        checks['uv (for fcp7xml export)'] = 'missing (optional) — brew install uv';
      }
      return out(checks);
    }

    default:
      fail(`unknown command: ${cmd}\n${HELP}`);
  }
}

main().catch((e) => fail(e?.message ?? String(e)));
