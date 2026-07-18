# Contributing to vedit

Issues and pull requests are welcome. vedit is a non-destructive local video
editor, so changes must never overwrite a user's source media or bypass the
revision/base-locking workflow.

## Development setup

```bash
git clone https://github.com/akakeishin/vedit.git
cd vedit
npm ci
npm run build
npm test -- --run
npm run verify:package
npm run verify:install
```

Use Node.js 20 or newer. ffmpeg/ffprobe are required for real-media smoke
tests, but most unit tests use isolated stubs.

## Pull requests

- Keep source media, rendered videos, `dist/`, caches, and Playwright output
  out of commits.
- Add focused tests for behavior changes.
- Preserve optimistic locking (`--base`) for mutations.
- Do not add uploads, publishing, or other external effects without an
  explicit user-confirmation boundary.
- Run the build, relevant tests, and package verification before opening the
  pull request.

Security reports belong in the private channel described in
[SECURITY.md](SECURITY.md), not in a public issue.
