import { mkdir, readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ClientFault } from './errors.mjs';

export class StateStore {
  constructor(directory = process.env.CHAOXING_DATA_DIR || fileURLToPath(new URL('../../.local/state/', import.meta.url))) {
    this.directory = directory;
  }
  async read(key, missing = null) {
    try { return JSON.parse(await readFile(join(this.directory, `${key}.json`), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return missing;
      throw new ClientFault('INVALID_STATE', `Cannot read local ${key} data`);
    }
  }
  async write(key, value) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = join(this.directory, `${key}.json`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, destination);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  async settings(update) {
    const current = await this.read('settings', { ignoreCourses: [], ignoreTasks: [], delayMs: 1500 });
    if (!update || Object.keys(update).length === 0) return current;
    const merged = { ...current };
    for (const key of Object.keys(update)) {
      if (!['ignoreCourses', 'ignoreTasks', 'delayMs'].includes(key)) throw new ClientFault('INVALID_INPUT', 'Unknown setting');
      const value = update[key];
      if (value === undefined) continue;
      if (key === 'delayMs') {
        if (!Number.isInteger(value) || value < 1500 || value > 30000) throw new ClientFault('INVALID_INPUT', 'delayMs must be an integer from 1500 to 30000');
        merged[key] = value;
      } else {
        if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string' && entry.trim().length > 0)) throw new ClientFault('INVALID_INPUT', 'Ignore lists must contain nonempty strings');
        merged[key] = [...new Set(value)];
      }
    }
    await this.write('settings', merged);
    return merged;
  }
  async snapshot() {
    const value = await this.read('snapshot');
    if (!value) throw new ClientFault('NO_DATA', 'Run a synchronization before querying local results');
    return value;
  }
  async commit(value) {
    const previous = await this.read('snapshot');
    if (previous) await this.write('previous', previous);
    await this.write('snapshot', value);
  }
  async exclusive(action) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, 'sync.lock');
    let handle;
    try { handle = await open(path, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await readFile(path, 'utf8')); } catch {}
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); }
        catch (check) {
          if (check.code === 'ESRCH') {
            await unlink(path).catch(e => { if (e.code !== 'ENOENT') throw e; });
            return this.exclusive(action);
          }
        }
      }
      throw new ClientFault('BUSY', 'Another synchronization is active');
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return await action();
    } finally { await handle.close(); await unlink(path).catch(() => {}); }
  }
}
