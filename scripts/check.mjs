import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
let files = 0;
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', '.local', 'node_modules'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink must be reviewed: ${relative(root, path)}`);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name.endsWith('.mjs')) {
      const check = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      if (check.status !== 0) throw new Error(check.stderr);
      files++;
    } else if (entry.name.endsWith('.json')) JSON.parse(await readFile(path, 'utf8'));
  }
}
await walk(root);
process.stdout.write(`Checked syntax of ${files} modules and JSON metadata.\n`);
