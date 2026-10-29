// 人设成长层自检：
//   node scripts/test-persona-growth.mjs          # 单测 + HTTP（需要桥接在 3100 跑）
//   node scripts/test-persona-growth.mjs --unit   # 只跑单测
import { resolveChatTargets } from './lib/owner.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPersonaGrowth } from '../src/persona-growth.js';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
};

const { ownerQQ: OWNER_QQ, groupQQ: GROUP_QQ, peerQQ: PEER_QQ } = resolveChatTargets();
const OWNER = `private:${OWNER_QQ}`;
const GROUP = `group:${GROUP_QQ}`;
const OTHER = `private:${PEER_QQ}`;

function unitTests() {
  console.log('\n[1] 人设成长单测');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grow-'));
  const filePath = path.join(dir, 'persona-growth.json');
  const historyPath = path.join(dir, 'persona-growth-history.jsonl');
  const grow = createPersonaGrowth({
    filePath,
    historyPath,
    log: () => {},
    // 用一个可观察的 sanitize：把明显的令牌打码，验证模块确实走了它。
    sanitize: (t) => String(t).replace(/tk_[a-z0-9]+/gi, '[redacted]'),
    isSensitive: (t) => /accessToken\s*[:=]/i.test(t)
  });

  const a1 = grow.add({ role: '小鲸鱼', text: '最近老爱说“绷”', kind: 'quirk', sourceKey: OWNER });
  ok(a1.ok && typeof a1.id === 'string', '加一条（习惯）', JSON.stringify(a1).slice(0, 120));
  ok(grow.list({ role: '小鲸鱼' }).length === 1, 'list() 读回 1 条');
  ok(grow.list({ role: '小鲸鱼' })[0].kindLabel === '习惯', 'kind 有中文标签');

  const fmt = grow.format('小鲸鱼');
  ok(fmt.includes('【人设成长】') && fmt.includes('绷'), 'format() 可供注入', fmt.slice(0, 60));

  // 待审：任何聊天都能提交，但不生效（不注入）
  const pend = grow.add({ role: '小鲸鱼', text: '好像越来越爱用省略号…', kind: 'quirk', sourceKey: GROUP, status: 'pending' });
  ok(pend.ok && pend.status === 'pending', '可以提交待审条目', JSON.stringify(pend).slice(0, 120));
  ok(!grow.format('小鲸鱼').includes('省略号'), '待审条目不注入提示词');
  ok(grow.list({ role: '小鲸鱼', status: 'pending' }).length === 1, 'list(status=pending) 能筛出来');
  ok(grow.stats().pending === 1, 'stats() 报待审数量', JSON.stringify(grow.stats()));

  const ap = grow.approve({ role: '小鲸鱼', id: pend.id });
  ok(ap.ok && grow.format('小鲸鱼').includes('省略号'), '通过后立刻生效', JSON.stringify(ap).slice(0, 100));
  const ap2 = grow.approve({ role: '小鲸鱼', id: pend.id });
  ok(ap2.ok && ap2.already === true, '重复通过是无害操作');

  const manyPending = createPersonaGrowth({ filePath: path.join(dir, 'p3.json'), maxPending: 2, log: () => {} });
  manyPending.add({ role: 'R', text: 'p1', status: 'pending' });
  manyPending.add({ role: 'R', text: 'p2', status: 'pending' });
  const overflow = manyPending.add({ role: 'R', text: 'p3', status: 'pending' });
  ok(!overflow.ok && /待审条目已满 2 条/.test(overflow.error), '待审数量有上限', overflow.error);

  const fullApprove = createPersonaGrowth({ filePath: path.join(dir, 'p4.json'), maxEntries: 1, log: () => {} });
  fullApprove.add({ role: 'R', text: '已生效' });
  const p2 = fullApprove.add({ role: 'R', text: '待通过', status: 'pending' });
  const blocked = fullApprove.approve({ role: 'R', id: p2.id });
  ok(!blocked.ok && /已满 1 条/.test(blocked.error), '已生效满了不通过待审', blocked.error);

  const countBeforeDup = grow.list({ role: '小鲸鱼' }).length;
  const dup = grow.add({ role: '小鲸鱼', text: '最近老爱说“绷”' });
  ok(dup.ok && dup.duplicate === true && grow.list({ role: '小鲸鱼' }).length === countBeforeDup, '同一条不重复加');

  const sanitized = grow.add({ role: '小鲸鱼', text: '口令是 tk_abcdef 别记' });
  ok(sanitized.ok && grow.list({ role: '小鲸鱼' }).some((e) => e.text.includes('[redacted]')), 'sanitize 生效');

  const tooLong = grow.add({ role: '小鲸鱼', text: '啊'.repeat(120) });
  ok(!tooLong.ok && /80 字/.test(tooLong.error), '单条超 80 字被拒', tooLong.error);

  const rotten = grow.add({ role: '小鲸鱼', text: 'accessToken: zzz' });
  ok(!rotten.ok && /敏感/.test(rotten.error), '敏感内容拒写', rotten.error);

  const beforeBroken = grow.list({ role: '小鲸鱼' }).length;
  for (let i = 0; i < 12; i += 1) grow.add({ role: '小鲸鱼', text: `成长条目 ${i}` });
  const full = grow.add({ role: '小鲸鱼', text: '再来一条' });
  ok(!full.ok && /已满 12 条/.test(full.error), '超过 12 条被拒（默认上限已可配置）', full.error);
  ok(grow.list({ role: '小鲸鱼' }).length === 12, '上限内数量正确', `${beforeBroken} -> ${grow.list({ role: '小鲸鱼' }).length}`);

  const longRole = createPersonaGrowth({ filePath: path.join(dir, 'g2.json'), maxTotalChars: 30, log: () => {} });
  longRole.add({ role: '小鲸鱼', text: '一'.repeat(20) });
  const over = longRole.add({ role: '小鲸鱼', text: '二'.repeat(20) });
  ok(!over.ok && /总字数/.test(over.error), '总字数上限被拒', over.error);

  const target = grow.list({ role: '小鲸鱼' })[0];
  const rm = grow.remove({ role: '小鲸鱼', id: target.id });
  ok(rm.ok && rm.removed === 1 && grow.list({ role: '小鲸鱼' }).length === 11, '按 id 删除');

  const cl = grow.clear({ role: '小鲸鱼' });
  ok(cl.ok && cl.removed === 11 && grow.format('小鲸鱼') === '', '清空后人设成长不注入', JSON.stringify(cl));

  ok(grow.format('不存在的角色') === '', '没条目时返回空串（不留空标题）');
  ok(grow.add({ role: '', text: 'x' }).ok === false, '角色名为空被拒');
  ok(grow.stats().maxEntries === 12 && grow.stats().maxTotalChars === 600, 'stats() 暴露上限（默认 12 条/600 字）', JSON.stringify(grow.stats()));

  const hist = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok(hist.some((r) => r.op === 'add') && hist.some((r) => r.op === 'remove') && hist.some((r) => r.op === 'clear'), '审计文件记录了 add/remove/clear', `${hist.length} 行`);

  // 坏文件：停写而不是覆盖用户内容
  const brokenPath = path.join(dir, 'broken.json');
  fs.writeFileSync(brokenPath, '{ not json', 'utf8');
  const brokenGrow = createPersonaGrowth({ filePath: brokenPath, log: () => {} });
  const b = brokenGrow.add({ role: '小鲸鱼', text: '不该写进去' });
  ok(!b.ok && /损坏/.test(b.error), '坏文件下停写', b.error);
  ok(fs.readFileSync(brokenPath, 'utf8') === '{ not json', '坏文件没被覆盖');
}

async function httpTests() {
  console.log('\n[2] HTTP 端到端（需要桥接在 3100 运行）');
  const base = 'http://127.0.0.1:3100';
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').trim();
  let consoleToken = '';
  try { consoleToken = read('state/console-token'); } catch { /* ignore */ }
  let social = {};
  try { social = JSON.parse(read('state/social-v2.json')); } catch { /* ignore */ }
  const ownerToken = social?.conversations?.[OWNER]?.agentToken || '';
  const otherToken = social?.conversations?.[OTHER]?.agentToken || '';
  if (!consoleToken) { console.log('  ⚠️ 没有 console-token，跳过 HTTP 部分'); return; }
  try { await fetch(`${base}/api/status`, { headers: { 'x-console-token': consoleToken } }); }
  catch (error) { console.log(`  ⚠️ 桥接没在跑（${error?.message ?? error}），跳过 HTTP 部分`); return; }

  const hdr = { 'content-type': 'application/json', 'x-console-token': consoleToken };
  const post = async (p, body, extra = {}) => {
    const res = await fetch(`${base}${p}`, { method: 'POST', headers: { ...hdr, ...extra }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  const get = async (p, extra = {}) => {
    const res = await fetch(`${base}${p}`, { headers: { ...hdr, ...extra } });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  const marker = `自检成长-${Date.now()}`;
  const list0 = await get('/api/socialV2/persona-growth?all=1');
  ok(list0.status === 200 && list0.data.ok && typeof list0.data.role === 'string', '管理页可读人设成长', JSON.stringify(list0.data).slice(0, 100));
  ok(list0.data.stats?.maxEntries === 12 && list0.data.stats?.maxTotalChars === 600, '上限来自 config.json 的 memory.personaGrowth（12 条 / 600 字）', JSON.stringify(list0.data.stats));

  const add = await post('/api/socialV2/persona-growth', { op: 'add', text: marker, kind: 'quirk' });
  ok(add.status === 200 && add.data.ok && add.data.format.includes(marker), '控制台可加一条', JSON.stringify(add.data).slice(0, 140));

  // 管理员会话（带 x-agent-call）也能写；别人的会话不行。
  if (ownerToken) {
    const own = await post('/api/socialV2/persona-growth', { key: OWNER, op: 'add', text: `${marker}-owner` }, { 'x-agent-token': ownerToken, 'x-agent-call': '1' });
    ok(own.status === 200 && own.data.ok, '管理员会话可写', JSON.stringify(own.data).slice(0, 120));
    const pr = await get(`/api/socialV2/prompt-preview?key=${encodeURIComponent(OWNER)}`, { 'x-agent-token': ownerToken });
    const promptText = String(pr.data?.prompt || '');
    ok(promptText.includes('【人设成长】') && promptText.includes(marker), '唤醒提示里出现【人设成长】', `chars=${promptText.length}`);
  } else {
    console.log('  ⚠️ 没有管理员会话令牌，跳过 agent 通道用例');
  }
  if (otherToken) {
    // 非管理员会话：可以提交，但落成待审、不生效（新行为，取代原来的 403）
    const submit = await post('/api/socialV2/persona-growth', { key: OTHER, op: 'add', text: `${marker}-peer`, kind: 'quirk' }, { 'x-agent-token': otherToken, 'x-agent-call': '1' });
    ok(submit.status === 200 && submit.data.ok && submit.data.pendingReview === true, '非管理员会话提交落成待审', JSON.stringify(submit.data).slice(0, 160));
    ok(!String(submit.data.format || '').includes(`${marker}-peer`), '待审条目不进注入文本');
    const removed = await post('/api/socialV2/persona-growth', { key: OTHER, op: 'remove', id: submit.data.id }, { 'x-agent-token': otherToken, 'x-agent-call': '1' });
    ok(removed.status === 403 && /只有管理员/.test(String(removed.data?.error || '')), '非管理员会话不能删改', JSON.stringify(removed.data).slice(0, 120));
    // 控制台通过 → 生效
    const approve = await post('/api/socialV2/persona-growth', { op: 'approve', id: submit.data.id });
    ok(approve.status === 200 && approve.data.ok && String(approve.data.format || '').includes(`${marker}-peer`), '控制台通过后生效', JSON.stringify(approve.data).slice(0, 140));
  }

  const after = await get('/api/socialV2/persona-growth?all=1');
  ok(Array.isArray(after.data.entries) && after.data.entries.some((e) => e.text.startsWith(marker)), '列表能看到刚加的条目');

  // 清理自检条目（含 -owner 那条）
  for (const entry of (after.data.entries || []).filter((e) => String(e.text).startsWith(marker))) {
    await post('/api/socialV2/persona-growth', { op: 'remove', id: entry.id });
  }
  const final = await get('/api/socialV2/persona-growth?all=1');
  ok(!(final.data.entries || []).some((e) => String(e.text).startsWith(marker)), '自检条目已清理');
}

unitTests();
if (!process.argv.includes('--unit')) await httpTests();

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);