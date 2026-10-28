import { resolveChatTargets } from './lib/owner.mjs';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:3100';
const CONSOLE = fs.readFileSync('state/console-token', 'utf8').trim();
const H = { 'x-console-token': CONSOLE, 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = async () => {
  try {
    const r = await fetch(`${BASE}/api/status`, { headers: { 'x-console-token': CONSOLE }, signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
};
const waitUp = async (ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const s = await status(); if (s?.dshReady) return s; await sleep(700); }
  return null;
};
const waitDown = async (ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!(await status())) return true; await sleep(400); }
  return false;
};
const ownerToken = () => {
  const st = JSON.parse(fs.readFileSync('state/social-v2.json', 'utf8'));
  return st.conversations?.[`private:${resolveOwnerQQ()}`]?.agentToken ?? '';
};
const otherToken = () => {
  const st = JSON.parse(fs.readFileSync('state/social-v2.json', 'utf8'));
  return st.conversations?.[`private:${resolveChatTargets().peerQQ}`]?.agentToken ?? '';
};
const admin = async (body) => {
  const r = await fetch(`${BASE}/api/admin/config`, { method: 'POST', headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
};

console.log('== 重启桥接加载新路由 ==');
await fetch(`${BASE}/api/restart`, { method: 'POST', headers: H, body: '{}' }).catch(() => {});
await waitDown();
const r = spawnSync(process.execPath, ['launch-detached.mjs'], { encoding: 'utf8' });
console.log(String(r.stdout || r.stderr || '').trim());
const up = await waitUp();
console.log('ready:', up ? `mode=${up.mode} dshReady=${up.dshReady}` : '超时');
if (!up) process.exit(1);

const owner = ownerToken();
console.log('\n== 1) owner 令牌 get ==');
const g = await admin({ token: owner, op: 'get' });
console.log(g.status, JSON.stringify({ allow: g.allow, ownerQQ: g.ownerQQ, mode: g.mode }));

console.log('\n== 2) 乱写令牌 get（应 403）==');
const bad = await admin({ token: 'deadbeefdeadbeefdeadbeef', op: 'get' });
console.log(bad.status, bad.error || '');

const other = otherToken();
if (other) {
  console.log('\n== 3) 非管理员会话令牌 get（应 403）==');
  const o = await admin({ token: other, op: 'get' });
  console.log(o.status, o.error || '');
}

console.log('\n== 4) add 99999999 ==');
const add = await admin({ token: ownerToken(), op: 'whitelist', kind: 'private', add: 99999999 });
console.log(add.status, JSON.stringify(add.allow ?? add.error));
const disk1 = JSON.parse(fs.readFileSync('config.json', 'utf8')).allow.private;
console.log('config.json allow.private =', JSON.stringify(disk1));

console.log('\n== 5) remove 99999999 ==');
const rm = await admin({ token: ownerToken(), op: 'whitelist', kind: 'private', remove: 99999999 });
console.log(rm.status, JSON.stringify(rm.allow ?? rm.error));
const disk2 = JSON.parse(fs.readFileSync('config.json', 'utf8')).allow.private;
console.log('config.json allow.private =', JSON.stringify(disk2));
console.log(disk2.includes(99999999) ? '❌ 残留未清理' : '✅ 已清理干净');
