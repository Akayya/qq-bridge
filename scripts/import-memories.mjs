// 把 state/social-v2.json 里已有的轻量记忆（话题 / 想法 / 对群友的印象）导入跨聊天共享记忆库。
//
//   node scripts/import-memories.mjs            # 预览（默认，不写库）
//   node scripts/import-memories.mjs --apply    # 真正写入 state/memory.db
//
// 映射规则（保守，先不放大可见范围）：
//   · activeTopic      → kind=fact, tags=[话题],  scope=key:<原会话>   （只有那个聊天看得见）
//   · pendingThought   → kind=fact, tags=[想法],  scope=key:<原会话>
//   · memberImpression → kind=bond, tags=[印象],  scope=owner           （收敛到管理员私聊，跨聊天可见、群聊里看不到）
// 重复执行安全：UNIQUE(text, scope) 命中时只更新 used_at。
import fs from 'node:fs';
import path from 'node:path';
import { createSharedMemory } from '../src/shared-memory.js';
import { SENSITIVE_RE } from '../src/sensitive.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATE = path.join(ROOT, 'state');
const APPLY = process.argv.includes('--apply');

const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};

const social = readJson(path.join(STATE, 'social-v2.json'), { conversations: {} });
const config = readJson(path.join(ROOT, 'config.json'), {});
const ownerQQ = Number(config?.ownerQQ) || null;
const ownerKey = ownerQQ ? `private:${ownerQQ}` : '';

// 已知的会话令牌原文：导入前统一打码，避免把令牌写进长期记忆。
const knownTokens = Object.values(social.conversations || {})
  .map((c) => String(c?.agentToken || ''))
  .filter((t) => t.length >= 12);
const sanitize = (text) => {
  let out = String(text ?? '');
  for (const token of knownTokens) out = out.split(token).join('***');
  return out.replace(/\[CQ:/gi, '[CQ：');
};
const isSensitive = (text) => SENSITIVE_RE.test(String(text ?? '').replace(/[A-Za-z]:[\\/][^\s"'<>|]*/g, ''));

const entries = [];
const skipped = [];
for (const [key, conv] of Object.entries(social.conversations || {})) {
  for (const t of Array.isArray(conv?.activeTopics) ? conv.activeTopics : []) {
    const text = sanitize(t?.text);
    if (!text) continue;
    if (isSensitive(text)) { skipped.push({ key, why: '敏感文本', text }); continue; }
    entries.push({ kind: 'fact', text, scope: `key:${key}`, sourceKey: key, tags: ['话题'] });
  }
  for (const t of Array.isArray(conv?.pendingThoughts) ? conv.pendingThoughts : []) {
    const text = sanitize(t?.text);
    if (!text) continue;
    if (isSensitive(text)) { skipped.push({ key, why: '敏感文本', text }); continue; }
    entries.push({ kind: 'fact', text, scope: `key:${key}`, sourceKey: key, tags: ['想法'] });
  }
  for (const [target, imp] of Object.entries(conv?.memberImpressions || {})) {
    const traits = (Array.isArray(imp?.traits) ? imp.traits : []).map((s) => sanitize(String(s)).trim()).filter(Boolean);
    if (!traits.length) continue;
    const text = `对 ${target} 的印象：${traits.join('；')}`;
    if (isSensitive(text)) { skipped.push({ key, why: '敏感文本', text }); continue; }
    // 印象收敛到管理员私聊：跨聊天可见，但其它私聊/群聊里看不到别人的评价。
    // trusted: 本脚本是管理员在本机手动跑的，允许写 owner 作用域（对话里的工具没有这个权限）。
    const scope = ownerKey ? 'owner' : `key:${key}`;
    entries.push({ kind: 'bond', text, scope, sourceKey: key, tags: ['印象', target], trusted: true });
  }
}

console.log(`扫描到 ${entries.length} 条可导入记忆（跳过 ${skipped.length} 条）`);
const byKind = entries.reduce((acc, e) => { acc[e.kind] = (acc[e.kind] || 0) + 1; return acc; }, {});
const byScope = entries.reduce((acc, e) => { const s = e.scope.startsWith('key:') ? 'key:*' : e.scope; acc[s] = (acc[s] || 0) + 1; return acc; }, {});
console.log('  按类型：', JSON.stringify(byKind));
console.log('  按可见范围：', JSON.stringify(byScope));
console.log('\n预览（前 8 条）：');
for (const e of entries.slice(0, 8)) console.log(`  [${e.kind}/${e.scope}] ${e.text.slice(0, 90)}${e.text.length > 90 ? '…' : ''}`);
if (skipped.length) {
  console.log('\n跳过明细（前 5 条）：');
  for (const s of skipped.slice(0, 5)) console.log(`  · ${s.key}（${s.why}）${s.text.slice(0, 60)}`);
}

if (!APPLY) {
  console.log('\n这是预览模式，没有写库。确认无误后加 --apply 真正导入。');
  process.exit(0);
}

const mem = createSharedMemory({
  dbPath: path.join(STATE, 'memory.db'),
  ownerQQ,
  log: (m) => console.log(`  [shared-memory] ${m}`),
  sanitize,
  isSensitive
});
const result = mem.importMany(entries);
const stats = mem.stats();
mem.close();
console.log(`\n导入完成：成功 ${result.imported} 条，跳过 ${result.skipped} 条`);
if (result.errors?.length) console.log('  失败原因样例：', result.errors.join(' | '));
console.log('  当前库内：', JSON.stringify(stats.byScope), `共 ${stats.total} 条`);
console.log('\n原来的 state/social-v2.json 没动，两套记忆暂时并存（共享库接管跨聊天部分）。');