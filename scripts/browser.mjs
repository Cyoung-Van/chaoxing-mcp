import { spawn } from 'node:child_process';
import { mkdir, open, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.CHAOXING_CDP_PORT ?? 9444);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('CHAOXING_CDP_PORT must be between 1024 and 65535');
const endpoint = `http://127.0.0.1:${port}`;
async function connected() {
  try {
    const result = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) });
    return result.ok && typeof (await result.json()).webSocketDebuggerUrl === 'string';
  } catch { return false; }
}
if (!await connected()) {
  const candidates = process.env.CHROME_PATH ? [process.env.CHROME_PATH] : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform === 'win32'
      ? [join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe')]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  let executable;
  for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
  if (!executable) throw new Error('Chrome was not found. Set CHROME_PATH to its executable path.');
  const profile = process.env.CHAOXING_PROFILE_DIR || join(root, '.local/browser');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await mkdir(join(root, '.local'), { recursive: true, mode: 0o700 });
  const log = await open(join(root, '.local/browser.log'), 'a', 0o600);
  const child = spawn(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', 'https://i.chaoxing.com/'], { detached: true, stdio: ['ignore', log.fd, log.fd] });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref(); await log.close();
  for (let attempt = 0; attempt < 40 && !await connected(); attempt++) await new Promise(resolve => setTimeout(resolve, 250));
  if (!await connected()) throw new Error('Chrome did not expose its local CDP endpoint. See .local/browser.log.');
} else {
  const tabs = await fetch(`${endpoint}/json/list`).then(result => result.json());
  if (!tabs.some(tab => { try { return new URL(tab.url).hostname.endsWith('.chaoxing.com'); } catch { return false; } })) {
    await fetch(`${endpoint}/json/new?${encodeURIComponent('https://i.chaoxing.com/')}`, { method: 'PUT' });
  }
}
process.stdout.write(`${JSON.stringify({ ok: true, endpoint, message: '请在课程浏览器中登录学习通。' })}\n`);
