import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i += 1) {
    try {
      const hasPkg = fs.existsSync(path.join(dir, 'package.json'));
      const hasGit = fs.existsSync(path.join(dir, '.git'));
      if (hasPkg || hasGit) return dir;
    } catch {
      // ignore
    }

    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }

  return startDir;
}

const REPO_ROOT = findRepoRoot(__dirname);

export const APP_BUILD = (() => {
  const envCommit = (
    process.env.GIT_COMMIT ||
    process.env.GIT_SHA ||
    process.env.SOURCE_VERSION ||
    process.env.COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA
  );
  const envBranch = process.env.GIT_BRANCH || process.env.VERCEL_GIT_COMMIT_REF;

  let version = null;
  try {
    const envPkgVersion = typeof process.env.npm_package_version === 'string' ? process.env.npm_package_version.trim() : '';
    if (envPkgVersion) {
      version = envPkgVersion;
    } else {
      const pkgPath = path.join(REPO_ROOT, 'package.json');
      const pkgRaw = fs.readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(pkgRaw);
      version = String(pkg?.version || '').trim() || null;
    }
  } catch {
  }

  let commit = typeof envCommit === 'string' ? envCommit.trim() : '';
  if (commit) commit = commit.slice(0, 12);
  if (!commit) {
    try {
      commit = String(execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] }))
        .trim()
        .slice(0, 12);
    } catch {
      commit = '';
    }
  }

  let branch = typeof envBranch === 'string' ? envBranch.trim() : '';
  if (!branch) {
    try {
      branch = String(execSync('git rev-parse --abbrev-ref HEAD', { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
    } catch {
      branch = '';
    }
  }
  if (branch === 'HEAD') branch = '';

  const repoUrl = (process.env.GIT_REPO_URL || 'https://github.com/CappyTech/hcs-sync').replace(/\/+$/, '');

  return {
    version,
    commit: commit || null,
    branch: branch || null,
    commitUrl: commit ? `${repoUrl}/commit/${commit}` : null,
  };
})();
