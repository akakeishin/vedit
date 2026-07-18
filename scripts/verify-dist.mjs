import { execFileSync } from 'node:child_process';

execFileSync('git', ['diff', '--exit-code', '--', 'dist'], { stdio: 'inherit' });
const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'dist'], {
  encoding: 'utf8',
}).trim();

if (untracked) {
  console.error(`Untracked distribution files:\n${untracked}`);
  process.exit(1);
}

console.log('Committed dist/ matches the TypeScript build.');
