// 跨聊天共享记忆的自检：先跑纯模块单测（临时库），再对运行中的桥接做 HTTP 端到端测试。
//   node scripts/test-shared-memory.mjs           # 全部
//   node scripts/test-shared-memory.mjs --unit    # 只跑单测（不需要桥接在跑）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSharedMemory } from '../src/shared-memory.js';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
};

const OWNER = 'private:2086366020';
const GROUP = 'group:168778193';
const OTHER_PRIVATE = 'private:227277385';

function unitTests() {
  console.log('\n[1] 模块单测（临时库）');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shm-'));
  const dbPath = path.join(dir, 'memory.db');
  const mem = createSharedMemory({
    dbPath,
    ownerQQ: 2086366020,
    log: () => {},
    sanitize: (t) => String(t),
    isSensitive: (t) => /accessToken\s*[:=]/i.test(t)
  });

  // 默认 scope：只有本会话可见
  const a = mem.append({ kind: 'preference', text: '管理员喜欢喝冰美式', sourceKey: OWNER });
  ok(a.ok && a.scope === `key:${OWNER}`, '默认 scope 落在本会话', JSON.stringify(a));
  ok(mem.listFor(OWNER).length === 1 && mem.listFor(OTHER_PRIVATE).length === 0, '默认 scope 别的聊天看不见');

  // all 只有管理员能写
  const b = mem.append({ text: '我是小鲸鱼，DeepSeek 的桌面助手', scope: 'all', sourceKey: OWNER });
  ok(b.ok && b.scope === 'all', '管理员可写 all');
  ok(mem.listFor(GROUP).some((e) => e.text.includes('小鲸鱼')), 'all 对群可见');
  ok(mem.listFor(OTHER_PRIVATE).some((e) => e.text.includes('小鲸鱼')), 'all 对他人私聊可见');
  const c = mem.append({ text: '群友的秘密', scope: 'all', sourceKey: GROUP });
  ok(!c.ok && /只有管理员私聊/.test(c.error), '非管理员写 all 被拒', c.error);

  // owner scope：只有管理员私聊可见；别人写降级
  const d = mem.append({ text: '管理员明天要出差', scope: 'owner', sourceKey: OWNER });
  ok(d.ok && d.scope === 'owner', '管理员可写 owner');
  ok(mem.listFor(OWNER).some((e) => e.text.includes('出差')) && !mem.listFor(GROUP).some((e) => e.text.includes('出差')), 'owner 只在管理员私聊可见');
  const e1 = mem.append({ text: '这条不该外泄', scope: 'owner', sourceKey: GROUP });
  ok(e1.ok && e1.scope === `key:${GROUP}` && e1.downgradedFrom === 'owner', '群会话写 owner 被降级为自身 key', JSON.stringify(e1));

  // key: 只能指向自己
  const f = mem.append({ text: '偷看', scope: `key:${OWNER}`, sourceKey: GROUP });
  ok(!f.ok && /只能指向当前会话自己/.test(f.error), 'key:… 不能替别的聊天写', f.error);

  // groups scope
  const g = mem.append({ text: '本群周末开黑', scope: 'groups', sourceKey: GROUP });
  ok(g.ok && g.scope === 'groups' && mem.listFor(GROUP).some((x) => x.text.includes('开黑')), 'groups 对群可见');
  ok(!mem.listFor(OWNER).some((x) => x.text.includes('开黑')), 'groups 不对私聊可见');

  // 敏感文本
  const h = mem.append({ text: 'accessToken: abcdef123456', sourceKey: OWNER });
  ok(!h.ok && /敏感信息/.test(h.error), '敏感文本被拒', h.error);

  // 去重（同文本同 scope 更新而不是插两条）
  const before = mem.stats().total;
  const i1 = mem.append({ text: '管理员喜欢喝冰美式', kind: 'fact', sourceKey: OWNER });
  ok(i1.ok && mem.stats().total === before, '重复文本不新增条目', `${before} -> ${mem.stats().total}`);
  const sameText = mem.listFor(OWNER).filter((x) => x.text === '管理员喜欢喝冰美式');
  ok(sameText.length === 1 && sameText[0].kind === 'fact', '重复文本更新了 kind');

  // 注入上限：20 条 / 800 字，且注入推进 used_at
  for (let n = 0; n < 30; n += 1) mem.append({ text: `批量条目 ${n} `.padEnd(40, 'x'), sourceKey: GROUP });
  const injected = mem.injectFor(GROUP);
  const lines = injected.split('\n').filter((l) => l.startsWith('- '));
  ok(lines.length <= 20, `注入条数 ≤20（实际 ${lines.length}）`);
  ok(injected.replace(/【共享记忆】[^\n]*\n/, '').length <= 800, '注入正文 ≤800 字');
  ok(injected.startsWith('【共享记忆】'), '注入带【共享记忆】抬头');
  ok(mem.listFor(GROUP)[0].hits >= 1, '注入会累加 hits');

  // 删除
  const victim = mem.listFor(GROUP).find((x) => x.text.includes('批量条目 0'));
  const r1 = mem.remove({ id: victim.id });
  ok(r1.ok && r1.removed === 1, '按 id 删除', JSON.stringify(r1));
  const r2 = mem.remove({ text: '本群周末开黑' });
  ok(r2.ok && r2.removed === 1, '按文本删除', JSON.stringify(r2));
  const st = mem.stats();
  ok(st.ok && st.total > 0 && st.byScope && Object.keys(st.byScope).length >= 3, 'stats 按 scope 分组', JSON.stringify(st.byScope));

  mem.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

async function httpTests() {
  console.log('\n[2] HTTP 端到端（需要桥接在 3100 运行）');
  const base = 'http://127.0.0.1:3100';
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').trim();
  let consoleToken = '';
  try { consoleToken = read('state/console-token'); } catch { /* 没有就不测 */ }
  let social = {};
  try { social = JSON.parse(read('state/social-v2.json')); } catch { /* ignore */ }
  const ownerToken = social?.conversations?.[OWNER]?.agentToken || '';
  const groupToken = social?.conversations?.[GROUP]?.agentToken || '';

  let status;
  try { status = await (await fetch(`${base}/api/status`, { headers: consoleToken ? { 'x-console-token': consoleToken } : {} })).json(); }
  catch (error) { console.log(`  ⚠️ 桥接没在跑（${error?.message ?? error}），跳过 HTTP 部分`); return; }
  ok(status?.mode === 'reserved2', `桥接模式 ${status?.mode}`, JSON.stringify(status).slice(0, 120));

  if (!consoleToken || !ownerToken) { console.log('  ⚠️ 缺少 console-token / 管理员会话令牌，跳过 HTTP 部分'); return; }
  const hdr = { 'content-type': 'application/json', 'x-console-token': consoleToken };
  const post = async (p, body, extra = {}) => {
    const res = await fetch(`${base}${p}`, { method: 'POST', headers: { ...hdr, ...extra }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  const get = async (p, extra = {}) => {
    const res = await fetch(`${base}${p}`, { headers: { ...hdr, ...extra } });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  const marker = `自检条目-${Date.now()}`;
  const w = await post('/api/socialV2/memory-global', { key: OWNER, text: `共享记忆${marker}：管理员叫小鲸鱼的主人`, kind: 'fact', scope: 'all', tags: ['自检'] }, { 'x-agent-token': ownerToken });
  ok(w.status === 200 && w.data.ok === true && w.data.scope === 'all', '管理员写 all', JSON.stringify(w.data));
  const id = w.data.id;

  const q = await get(`/api/socialV2/memory-global?key=${encodeURIComponent(OWNER)}&limit=50`, { 'x-agent-token': ownerToken });
  ok(q.status === 200 && q.data.entries?.some((x) => x.text.includes(marker)), '管理员能查到刚写的条目');

  if (groupToken) {
    const qg = await get(`/api/socialV2/memory-global?key=${encodeURIComponent(GROUP)}&limit=50`, { 'x-agent-token': groupToken });
    ok(qg.status === 200 && qg.data.entries?.some((x) => x.text.includes(marker)), '群会话能看到 scope=all 的条目');
    const deny = await post('/api/socialV2/memory-global', { key: GROUP, text: '群会话想写全局', scope: 'all' }, { 'x-agent-token': groupToken });
    ok(deny.status === 403, '群会话写 all 被拒（403）', JSON.stringify(deny.data));
  }

  // 唤醒提示里确实带上了共享记忆（用 prompt-preview 看模型真实会收到的文本）
  const pr = await get(`/api/socialV2/prompt-preview?key=${encodeURIComponent(OWNER)}`, { 'x-agent-token': ownerToken });
  const promptText = String(pr.data?.prompt || '');
  ok(pr.status === 200 && promptText.includes('【共享记忆】'), '唤醒提示包含【共享记忆】段', `status=${pr.status}`);
  ok(promptText.includes(marker), '唤醒提示包含刚写入的条目');

  const rm = await post('/api/socialV2/memory-global-remove', { key: OWNER, id }, { 'x-agent-token': ownerToken });
  ok(rm.status === 200 && rm.data.removed === 1, '删除自检条目', JSON.stringify(rm.data));

  const after = await get(`/api/socialV2/memory-global?key=${encodeURIComponent(OWNER)}&limit=50`, { 'x-agent-token': ownerToken });
  ok(!after.data.entries?.some((x) => x.text.includes(marker)), '删除后查不到了');
}

unitTests();
if (!process.argv.includes('--unit')) await httpTests();

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);