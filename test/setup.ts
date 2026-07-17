import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll } from 'vitest';

// Global safety net for the whole suite.
//
// Several code paths resolve state under os.homedir() — the project
// registry (src/core/registry.ts, ~/.cache/vedit/projects.json), style
// presets (src/core/presets.ts, ~/.config/vedit/presets.json) — and
// os.homedir() re-reads process.env.HOME on every call rather than caching
// it at import time. Any test that transitively calls Project.create()
// (which unconditionally upserts into the registry) or savePreset()
// without first pointing HOME at a scratch dir ends up writing into the
// developer's REAL ~/.cache/vedit/projects.json. That's exactly how it
// accumulated hundreds of stale /var/folders/.../T/vedit-* test-scratch
// entries: most test files that create real Project instances (cli.test.ts,
// daemon.test.ts, project.test.ts, ops.test.ts, scenes.test.ts,
// ingest.test.ts, publish.test.ts) never isolated HOME themselves. This
// includes cli.test.ts, which spawns `tsx src/cli.ts` as a real child
// process via spawnSync — since it doesn't pass an explicit `env` option,
// the child inherits process.env (including our overridden HOME) from this
// process, same as if it were in-process.
//
// Rather than patch every test file individually (fragile — the next new
// test file would silently reintroduce the leak), set HOME once here for
// every test file in the suite. This runs once per test file (vitest
// re-executes setupFiles per file, not once for the whole run), so it
// composes fine with test files (registry.test.ts, presets.test.ts) that
// already swap HOME per-test in their own beforeEach/afterEach — theirs
// just layers a further-scoped tmpdir on top of this one and restores back
// to *this* fake HOME afterward, never the real one.
let fakeHome: string;
let realHome: string | undefined;

beforeAll(() => {
  realHome = process.env.HOME;
  fakeHome = mkdtempSync(path.join(tmpdir(), 'vedit-testhome-'));
  process.env.HOME = fakeHome;
});

afterAll(() => {
  process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
});
