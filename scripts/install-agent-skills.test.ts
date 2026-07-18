import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.resolve('scripts/install-agent-skills.mjs');

function run(args: string[], root: string) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      VEDIT_CODEX_SKILLS_DIR: path.join(root, 'codex'),
      VEDIT_CLAUDE_SKILLS_DIR: path.join(root, 'claude'),
    },
  });
}

describe('vedit-install-skills', () => {
  it('installs the bundled skill for Codex and Claude Code by default', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-install-skills-'));
    const result = run([], root);
    expect(result.status, result.stderr).toBe(0);
    expect(path.resolve(path.join(root, 'codex'), readlinkSync(path.join(root, 'codex', 'vedit')))).toBe(path.resolve('skill'));
    expect(path.resolve(path.join(root, 'claude'), readlinkSync(path.join(root, 'claude', 'vedit')))).toBe(path.resolve('skill'));
  });

  it('preserves an existing directory unless --force explicitly backs it up', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-install-skills-existing-'));
    const existing = path.join(root, 'codex', 'vedit');
    mkdirSync(existing, { recursive: true });
    writeFileSync(path.join(existing, 'mine.txt'), 'keep');

    const refused = run(['--codex'], root);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/already exists/);

    const forced = run(['--codex', '--force'], root);
    expect(forced.status, forced.stderr).toBe(0);
    expect(readlinkSync(existing)).toBe(path.resolve('skill'));
  });
});
