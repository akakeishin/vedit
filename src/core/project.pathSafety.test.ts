import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Project, resolveWithinDir } from './project.js';

function freshRoot(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `vedit-project-path-${prefix}-`));
}

describe('resolveWithinDir symlink containment', () => {
  it('rejects a not-yet-created child below an escaping symlink ancestor', async () => {
    const root = freshRoot('missing-child');
    const projectDir = path.join(root, 'project');
    const outside = path.join(root, 'outside');
    await fs.mkdir(path.join(projectDir, 'cache'), { recursive: true });
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(projectDir, 'cache', 'escape'));

    await expect(resolveWithinDir(projectDir, 'cache/escape/not-created.mp4'))
      .rejects.toThrow(/escapes directory \(symlink\)/);
    await expect(fs.lstat(path.join(outside, 'not-created.mp4'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows a missing child through a symlink that remains inside the base', async () => {
    const root = freshRoot('internal-link');
    const projectDir = path.join(root, 'project');
    await fs.mkdir(path.join(projectDir, 'cache', 'real'), { recursive: true });
    await fs.symlink(path.join(projectDir, 'cache', 'real'), path.join(projectDir, 'cache', 'inside'));

    await expect(resolveWithinDir(projectDir, 'cache/inside/not-created.mp4'))
      .resolves.toBe(path.join(projectDir, 'cache', 'inside', 'not-created.mp4'));
  });

  it('keeps lexical traversal and absolute-path rejection intact', async () => {
    const projectDir = freshRoot('lexical');
    await expect(resolveWithinDir(projectDir, '../outside')).rejects.toThrow(/escapes directory/);
    await expect(resolveWithinDir(projectDir, path.join(path.parse(projectDir).root, 'outside')))
      .rejects.toThrow(/escapes directory/);
  });
});

describe('Project managed filename builders', () => {
  it('rejects path-bearing ids before transcript, scene, or motion writers can create files', async () => {
    const root = freshRoot('managed-ids');
    const project = await Project.create(path.join(root, 'project'), 'safe');
    const attacks = ['../../outside', 'a/b', '..', '', 'a\\b'];
    for (const attack of attacks) {
      await expect(project.writeTranscript({ sourceId: attack, language: 'ja', words: [] }))
        .rejects.toThrow(/invalid source id/);
      await expect(project.writeScenes({ sourceId: attack, scenes: [] }))
        .rejects.toThrow(/invalid source id/);
      expect(() => project.motionSpecPath(attack)).toThrow(/invalid motion id/);
    }
    expect(await fs.readdir(root)).toEqual(['project']);
  });
});
