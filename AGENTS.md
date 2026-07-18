# vedit repository guidance

- This repository builds the local, non-destructive `vedit` video editor. Never
  modify or replace a user's source media as part of an edit.
- For video-editing requests, read `.agents/skills/vedit/SKILL.md`, then follow
  the complete canonical instructions it points to in `skill/SKILL.md`.
- Keep edits in the manifest/revision workflow and preserve optimistic locking
  (`--base`) for mutations. Do not bypass explicit confirmation for exports,
  publishing, uploads, or other external effects.
- Build with `npm run build`, run focused Vitest coverage for changed code, and
  use `npm run verify:package` when changing distribution files.
- Do not commit generated media, `dist/`, caches, Playwright artifacts, or local
  audit output unless a task explicitly calls for an artifact to be versioned.

