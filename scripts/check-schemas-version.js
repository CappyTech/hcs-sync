#!/usr/bin/env node
/**
 * Fail the build when the installed @cappytech/hcs-schemas is older than this
 * package's code requires.
 *
 * `@cappytech/hcs-schemas` is a git dependency (`github:CappyTech/hcs-schemas`).
 * That *looks* like a branch tip, but npm pins the resolved commit in
 * package-lock.json and CI installs with `npm ci`, so merging schemas to its
 * default branch changes nothing here. Updating the consumer is a separate,
 * easily-forgotten step: `npm install github:CappyTech/hcs-schemas` plus a
 * lockfile commit.
 *
 * It has been forgotten twice, and neither time was caught before an image was
 * published:
 *
 *   - hcs-sync 0.10.0 shipped built against schemas 2.0.0, without the
 *     bankReconciliation entity. It survived only because the consumer guards
 *     its use of new entities.
 *   - hcs-app 6.21.0 and hcs-sync 0.11.0 were merged before their lockfile
 *     updates landed, publishing images pinned to schemas 2.1.0 — which still
 *     declared bankTransaction's unique index on `Id` alone, the exact index
 *     that release exists to replace. Deploying it would have recreated the
 *     index the migration removes.
 *
 * Documenting the three-step deploy did not prevent either. A failing build
 * does. Bump `requiredSchemasVersion` in package.json in the same commit that
 * starts depending on new schema behaviour.
 */
import { readFile } from 'node:fs/promises';

const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

/** Numeric compare of dotted versions. Prerelease tags are not used here. */
function isAtLeast(actual, required) {
  const parse = (v) => String(v).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parse(actual), parse(required)];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

const pkg = await read('../package.json');
const required = pkg.requiredSchemasVersion;
if (!required) {
  console.error('[schemas-check] package.json is missing "requiredSchemasVersion".');
  process.exit(1);
}

let installed;
try {
  installed = (await read('../node_modules/@cappytech/hcs-schemas/package.json')).version;
} catch {
  console.error('[schemas-check] @cappytech/hcs-schemas is not installed. Run npm ci first.');
  process.exit(1);
}

if (!isAtLeast(installed, required)) {
  console.error(
    `[schemas-check] installed @cappytech/hcs-schemas is ${installed}, but this package requires >= ${required}.\n`
    + '\n'
    + 'The lockfile pins a commit, so merging hcs-schemas does not update this repo.\n'
    + 'Fix with:\n'
    + '\n'
    + '    npm install github:CappyTech/hcs-schemas\n'
    + '    git commit package-lock.json -m "chore: pin hcs-schemas"\n',
  );
  process.exit(1);
}

console.log(`[schemas-check] @cappytech/hcs-schemas ${installed} satisfies >= ${required}`);
