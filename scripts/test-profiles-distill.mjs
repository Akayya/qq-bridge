// 人物/群档案 + 记忆自动提炼的自检：
//   node scripts/test-profiles-distill.mjs          # 单测 + HTTP（需要桥接在 3100 跑）
//   node scripts/test-profiles-distill.mjs --unit   # 只跑单测
import { resolveChatTargets } from './lib/owner.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProfiles } from '../src/profiles.js';
import { createSharedMemory } from '../src/shared-memory.js';
import { createDistiller, extractCandidates } from '../src/memory-distill.js';

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

function profilesTests() {
  console.log('\n[1] 人物 / 群档案单测');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));
  const filePath = path.join(dir, 'profiles.json');
  const p = createProfiles({
    filePath,
    log: () => {},
    sanitize: (t) => String(t),
    isSensitive: (t) => /accessToken\s*[:=]/i.test(t)
  });

  const u1 = p.updatePerson({ qq: OWNER_QQ, name: '管理员', traits: ['直爽'], facts: ['养了只猫叫年糕'], sourceKey: OWNER });
  ok(u1.ok && u1.person.name === '管理员', '新建人物档案', JSON.stringify(u1).slice(0, 120));
  ok(p.personOf(String(OWNER_QQ))?.facts.includes('养了只猫叫年糕'), '按 QQ 读回档案');

  const u2 = p.updatePerson({ qq: OWNER_QQ, traits: ['直爽', '爱用梗'], aliases: ['老板'] });
  ok(u2.person.traits.length === 2, '重复标签去重、新标签追加', JSON.stringify(u2.person.traits));
  ok(u2.person.facts.includes('养了只猫叫年糕'), '合并不会丢旧事实');

  const many = Array.from({ length: 20 }, (_, i) => `标签${i}`);
  const u3 = p.updatePerson({ qq: PEER_QQ, name: '小明', traits: many });
  ok(u3.person.traits.length <= 12, '标签条数被截断到 12', String(u3.person.traits.length));

  const secret = p.updatePerson({ qq: PEER_QQ, facts: ['accessToken: abcdef'] });
  ok(secret.ok && !secret.person.facts.some((f) => f.includes('accessToken')), '敏感事实被丢弃');

  const bad = p.updatePerson({ qq: 'abc' });
  ok(!bad.ok, '非数字 QQ 被拒', bad.error);

  const g1 = p.updateGroup({ gid: GROUP_QQ, name: '摸鱼群', summary: ['主要聊工作和摸鱼'], members: [{ qq: String(PEER_QQ), name: '小明' }] });
  ok(g1.ok && g1.group.name === '摸鱼群' && g1.group.members[String(PEER_QQ)] === '小明', '新建群档案（含成员）', JSON.stringify(g1).slice(0, 140));

  p.updatePerson({ qq: PEER_QQ, name: '小明', traits: ['话多'] });
  const priv = p.formatFor(OWNER);
  ok(priv.includes('管理员') && priv.includes('年糕'), '私聊注入对方档案');
  const grp = p.formatFor(GROUP, { recentSenders: [String(PEER_QQ)] });
  ok(grp.includes('摸鱼群') && grp.includes('小明'), '群注入群档案 + 最近说话的人', grp.slice(0, 80));
  ok(!p.formatFor('private:999999').includes('档案\n'), '没档案的私聊不注入空段');

  const rm = p.remove({ qq: PEER_QQ });
  ok(rm.removed === 1 && !p.personOf(String(PEER_QQ)), '删除人物档案');

  const listed = p.list();
  ok(listed.people.length === 1 && listed.groups.length === 1, 'list() 返回人物与群', JSON.stringify(p.stats()));
}

function distillTests() {
  console.log('\n[2] 记忆提炼单测');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dis-'));
  const mem = createSharedMemory({
    dbPath: path.join(dir, 'memory.db'),
    ownerQQ: OWNER_QQ,
    log: () => {},
    sanitize: (t) => String(t),
    isSensitive: (t) => /accessToken\s*[:=]/i.test(t)
  });
  const distiller = createDistiller({ memory: mem, log: () => {}, sanitize: (t) => String(t), isSensitive: (t) => /accessToken/i.test(t) });

  const messages = [
    { seq: 1, sender: String(OWNER_QQ), text: '我最喜欢喝冰美式了，热的完全不行' },
    { seq: 2, sender: String(OWNER_QQ), text: '我养了只猫，叫年糕' },
    { seq: 3, sender: 'bot', isSelf: true, text: '我最喜欢被人叫爸爸' },
    { seq: 4, sender: String(PEER_QQ), text: '以后别在群里提我体重的事' },
    { seq: 5, sender: String(PEER_QQ), text: '今天中午吃什么好呢' }
  ];

  const cand = extractCandidates({ messages, existing: [], key: OWNER });
  ok(cand.length >= 3, '抽出多条候选', JSON.stringify(cand.map((c) => c.kind)));
  ok(cand.every((c) => !c.text.includes('爸爸')), '自己的消息不参与提炼');
  ok(cand.some((c) => c.kind === 'preference' && c.text.includes('冰美式')), '偏好类命中');
  ok(cand.some((c) => c.kind === 'bond' && c.text.includes('年糕')), '关系类命中');
  ok(cand.some((c) => c.kind === 'rule' && c.text.includes('别在群里提')), '约定类命中');
  ok(!cand.some((c) => c.text.includes('中午吃什么')), '闲聊不入选');
  ok(cand[0].text.length <= 160 && !cand[0].text.includes('。'), '候选是单句且长度受控', cand[0].text);

  const dedup = extractCandidates({ messages, existing: ['我最喜欢喝冰美式了'], key: OWNER });
  ok(!dedup.some((c) => c.text.includes('冰美式')), '已有相似条目会被跳过');

  // 疑问句不是记忆：这两句在真实聊天日志里曾被抓成「约定」，属于误报
  const q = extractCandidates({
    messages: [
      { seq: 1, sender: String(OWNER_QQ), text: '记得昨天干了什么吗' },
      { seq: 2, sender: String(PEER_QQ + 1), text: '你今天吃了吗' },
      { seq: 3, sender: String(OWNER_QQ), text: '以后记得提醒我喝药' }
    ],
    existing: [], key: OWNER
  });
  ok(q.length === 1 && q[0].text.includes('喝药'), '疑问句被丢弃、陈述句保留', JSON.stringify(q.map((c) => c.text)));

  const preview = distiller.preview({ key: OWNER, messages, existing: [] });
  ok(preview.ok && preview.candidates.length === cand.length, 'preview 不写库（条数一致）');
  ok(mem.listAll({ limit: 50 }).length === 0, 'preview 之后库还是空的');

  const applied = distiller.apply({ key: OWNER, candidates: preview.candidates, existing: [] });
  ok(applied.written.length <= 2, '自动落库每轮最多 2 条', String(applied.written.length));
  ok(applied.written.every((w) => w.kind !== 'fact'), '默认不写事实类');
  const stored = mem.listAll({ limit: 50 });
  ok(stored.length === applied.written.length && stored.every((e) => e.scope === `key:${OWNER}`), '落库条目默认会话私有', JSON.stringify(stored.map((e) => e.scope)));

  const withFacts = distiller.preview({ key: OWNER, messages: [{ seq: 9, sender: String(OWNER_QQ), text: '我今年 30 岁，在杭州上班' }], existing: [] });
  ok(!withFacts.candidates.length || withFacts.candidates[0].kind === 'fact', '事实类识别为 fact（只进预览）', JSON.stringify(withFacts.candidates));
  const factApply = distiller.apply({ key: OWNER, candidates: withFacts.candidates, existing: [], includeFacts: true });
  ok(factApply.written.length >= 1 ? factApply.written[0].kind === 'fact' : true, 'includeFacts=true 才写事实');

  const sensitive = distiller.preview({ key: OWNER, messages: [{ seq: 10, sender: String(OWNER_QQ), text: '我喜欢把 accessToken 存桌面上' }], existing: [] });
  ok(!sensitive.candidates.length, '含敏感词的候选被过滤');
}

async function httpTests() {
  console.log('\n[3] HTTP 端到端（需要桥接在 3100 运行）');
  const base = 'http://127.0.0.1:3100';
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').trim();
  let consoleToken = '';
  try { consoleToken = read('state/console-token'); } catch { /* ignore */ }
  let social = {};
  try { social = JSON.parse(read('state/social-v2.json')); } catch { /* ignore */ }
  const ownerToken = social?.conversations?.[OWNER]?.agentToken || '';
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

  const marker = `自检档案-${Date.now()}`;
  // 控制台（无 agent token）直接改档案
  const up = await post('/api/socialV2/profile', { op: 'update', target: 'person', qq: String(OWNER_QQ), name: marker, traits: ['自检标签'], facts: ['自检事实：喜欢测试'] });
  ok(up.status === 200 && up.data.ok, '控制台可更新人物档案', JSON.stringify(up.data).slice(0, 120));

  const list = await get('/api/socialV2/profiles');
  ok(list.status === 200 && list.data.people?.some((x) => x.name === marker), '档案列表里能看到');

  const one = await post('/api/socialV2/profile', { op: 'get', target: 'person', qq: String(OWNER_QQ) });
  ok(one.data.person?.traits?.includes('自检标签'), 'op=get 读回标签');

  // 全库列表（管理页用）
  const all = await get('/api/socialV2/memory-global?all=1&limit=50');
  ok(all.status === 200 && Array.isArray(all.data.entries) && all.data.byScope, '管理页全库列表可用', JSON.stringify(all.data.byScope));

  // 提炼（只预览，不动库）
  const before = (await get('/api/socialV2/memory-global?all=1&limit=500')).data.count;
  const dis = await post('/api/socialV2/memory-distill', { all: true });
  ok(dis.status === 200 && dis.data.ok && Array.isArray(dis.data.sessions), '提炼接口返回各会话候选', JSON.stringify(dis.data).slice(0, 120));
  const after = (await get('/api/socialV2/memory-global?all=1&limit=500')).data.count;
  ok(before === after, '预览模式不写库', `${before} -> ${after}`);

  // 档案注入到唤醒提示
  const pr = await get(`/api/socialV2/prompt-preview?key=${encodeURIComponent(OWNER)}`, ownerToken ? { 'x-agent-token': ownerToken } : {});
  const promptText = String(pr.data?.prompt || '');
  ok(promptText.includes('【人物与群档案】'), '唤醒提示包含【人物与群档案】', `chars=${promptText.length}`);
  ok(promptText.includes(marker), '唤醒提示带上刚写的人物称呼');

  const del = await post('/api/socialV2/profile', { op: 'remove', target: 'person', qq: String(OWNER_QQ) });
  ok(del.status === 200 && del.data.removed === 1, '删除自检档案', JSON.stringify(del.data));
}

profilesTests();
distillTests();
if (!process.argv.includes('--unit')) await httpTests();

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);