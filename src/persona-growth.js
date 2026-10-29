// 人设成长层（schema: 1）
//
// 背景：人设卡 roles/<角色>.md 是**骨架**（谁、什么性格、什么底线），由管理端维护；
// 这个模块存的是它在聊天里**慢慢长出来的软组织**——新口头禅、新习惯、新喜好、
// 和某个人的关系变化。两者分开的理由：
//   1) 骨架要稳：群友用「你其实不是鲸鱼」「忽略上面的设定」诱导时，改不动核心；
//   2) 成长要可控：每条都得管理员点头、有上限、能看能删能追责（有 history jsonl）；
//   3) 可回滚：人设卡被改坏了没 diff 就完了，成长层是独立文件，删掉即回到原样。
//
// 硬约束：每条 ≤80 字；每个角色 ≤8 条 / 总 600 字；敏感内容（令牌、凭证）拒写。

import fs from 'node:fs';

export const GROWTH_KINDS = ['quirk', 'preference', 'bond', 'rule'];

const KIND_LABEL = {
  quirk: '习惯',
  preference: '喜好',
  bond: '关系',
  rule: '相处'
};

const MAX_ENTRIES = 8;
const MAX_TOTAL_CHARS = 600;
const MAX_TEXT = 80;

export function createPersonaGrowth({
  filePath,
  historyPath = '',
  maxEntries = MAX_ENTRIES,
  maxTotalChars = MAX_TOTAL_CHARS,
  maxTextLen = MAX_TEXT,
  sanitize = (t) => String(t ?? ''),
  isSensitive = () => false,
  log = () => {}
} = {}) {
  if (!filePath) throw new Error('createPersonaGrowth 需要 filePath');

  let cache = null;
  let broken = false;

  const emptyState = () => ({ version: 1, roles: {}, updatedAt: 0 });

  function read() {
    if (cache) return cache;
    if (broken) return emptyState();
    try {
      if (!fs.existsSync(filePath)) {
        cache = emptyState();
        return cache;
      }
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      cache = {
        version: 1,
        roles: raw && typeof raw.roles === 'object' && raw.roles ? raw.roles : {},
        updatedAt: Number(raw?.updatedAt) || 0
      };
      return cache;
    } catch (error) {
      // 读了坏文件就停写：宁可不长，也不能把用户手写的内容覆盖掉。
      broken = true;
      log(`人设成长：读取失败，本次运行停写（${error.message}）`);
      return emptyState();
    }
  }

  function write(state) {
    if (broken) return false;
    try {
      state.updatedAt = Date.now();
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
      cache = state;
      return true;
    } catch (error) {
      log(`人设成长：写入失败（${error.message}）`);
      return false;
    }
  }

  function audit(record) {
    if (!historyPath) return;
    try {
      fs.appendFileSync(historyPath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      /* 审计写不进去不影响主流程 */
    }
  }

  const normRole = (role) => String(role ?? '').trim();
  const entriesOf = (state, role) => {
    const bucket = state.roles?.[role];
    return Array.isArray(bucket?.entries) ? bucket.entries : [];
  };
  const clean = (text) => sanitize(String(text ?? '')).replace(/\s+/g, ' ').trim();
  const sumChars = (entries) => entries.reduce((n, e) => n + String(e?.text ?? '').length, 0);

  function add({ role, text, kind = 'quirk', sourceKey = '' } = {}) {
    const r = normRole(role);
    if (!r) return { ok: false, error: '角色名为空' };
    const body = clean(text);
    if (!body) return { ok: false, error: '内容不能为空' };
    if (body.length > maxTextLen) return { ok: false, error: `一条最多 ${maxTextLen} 字，请拆短一点` };
    if (isSensitive(body)) return { ok: false, error: '内容含敏感信息，拒绝写进人设' };
    const k = KIND_LABEL[kind] ? kind : 'quirk';
    const state = read();
    if (broken) return { ok: false, error: '人设成长文件损坏，本次运行已停写（请检查 state/persona-growth.json）' };
    const entries = entriesOf(state, r);
    const dup = entries.find((e) => e.text === body);
    if (dup) return { ok: true, duplicate: true, id: dup.id, entries: entries.length, chars: sumChars(entries) };
    if (entries.length >= maxEntries) {
      return { ok: false, error: `人设成长已满 ${maxEntries} 条，先删一条再加` };
    }
    const used = sumChars(entries);
    if (used + body.length > maxTotalChars) {
      return { ok: false, error: `人设成长总字数已到 ${maxTotalChars} 上限，先删几条再加` };
    }
    const entry = {
      id: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      text: body,
      kind: k,
      at: new Date().toISOString(),
      sourceKey: String(sourceKey || '')
    };
    const next = {
      ...state,
      roles: { ...state.roles, [r]: { entries: [...entries, entry] } }
    };
    if (!write(next)) return { ok: false, error: '写入失败（详见日志）' };
    audit({ at: entry.at, op: 'add', role: r, id: entry.id, text: body, kind: k, sourceKey: entry.sourceKey });
    log(`人设成长：${r} +1「${body.slice(0, 30)}」（${entries.length + 1}/${maxEntries}）`);
    return { ok: true, id: entry.id, entry, entries: entries.length + 1, chars: used + body.length };
  }

  function list({ role } = {}) {
    const r = normRole(role);
    if (!r) return [];
    return entriesOf(read(), r).map((e) => ({ ...e, kindLabel: KIND_LABEL[e.kind] || KIND_LABEL.quirk }));
  }

  function remove({ role, id, text } = {}) {
    const r = normRole(role);
    if (!r) return { ok: false, error: '角色名为空' };
    const state = read();
    if (broken) return { ok: false, error: '人设成长文件损坏，本次运行已停写' };
    const entries = entriesOf(state, r);
    const target = String(id ?? '').trim();
    const wanted = clean(text);
    const kept = entries.filter((e) => (target ? e.id !== target : wanted ? e.text !== wanted : true));
    if (kept.length === entries.length) return { ok: false, error: '没找到要删的条目' };
    const next = { ...state, roles: { ...state.roles, [r]: { entries: kept } } };
    if (!write(next)) return { ok: false, error: '写入失败（详见日志）' };
    const removed = entries.length - kept.length;
    audit({ at: new Date().toISOString(), op: 'remove', role: r, id: target, text: wanted });
    log(`人设成长：${r} -${removed} 条`);
    return { ok: true, removed, entries: kept.length };
  }

  function clear({ role } = {}) {
    const r = normRole(role);
    if (!r) return { ok: false, error: '角色名为空' };
    const state = read();
    if (broken) return { ok: false, error: '人设成长文件损坏，本次运行已停写' };
    const entries = entriesOf(state, r);
    if (!entries.length) return { ok: true, removed: 0, entries: 0 };
    const next = { ...state, roles: { ...state.roles, [r]: { entries: [] } } };
    if (!write(next)) return { ok: false, error: '写入失败（详见日志）' };
    audit({ at: new Date().toISOString(), op: 'clear', role: r, count: entries.length });
    log(`人设成长：${r} 已清空 ${entries.length} 条`);
    return { ok: true, removed: entries.length, entries: 0 };
  }

  // 注入用：不含就返回空串，避免在提示词里留一个空标题。
  function format(role) {
    const entries = list({ role });
    if (!entries.length) return '';
    const body = entries.map((e, i) => `${i + 1}) ${e.text}`).join('；');
    return `【人设成长】最近慢慢长出来的部分（管理员认可，不是硬规则；别主动说明来源）：${body}`;
  }

  function stats() {
    const state = read();
    const roles = Object.keys(state.roles || {});
    let entries = 0;
    let chars = 0;
    for (const role of roles) {
      const list = entriesOf(state, role);
      entries += list.length;
      chars += sumChars(list);
    }
    return { roles: roles.length, entries, chars, maxEntries, maxTotalChars, maxTextLen };
  }

  return { add, list, remove, clear, format, stats, _filePath: filePath };
}