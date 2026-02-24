import { execSync } from 'child_process';

let _repoRoot = null;

export function getRepoRoot() {
  if (_repoRoot) return _repoRoot;
  try {
    _repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  } catch {
    _repoRoot = process.cwd(); // fallback
  }
  return _repoRoot;
}
