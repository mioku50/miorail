import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// markdownlint-cli expands globs before applying .markdownlintignore. Walking
// an entire checkout therefore traverses private captures, media skill copies
// and their node_modules even when every result will later be ignored. The
// Git index is the project's source universe; the CLI still applies its usual
// rule config and ignore file to those exact paths. No shell parses filenames.
const files = execFileSync('git', ['ls-files', '-z', '--', '*.md', '*.markdown'], { encoding: 'utf8' })
  .split('\0').filter(Boolean);
if (files.length > 0) {
  const require = createRequire(import.meta.url);
  const cli = require.resolve('markdownlint-cli/markdownlint.js');
  const result = spawnSync(process.execPath, [cli, '--', ...files], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
