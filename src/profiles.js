// 人物与群档案（state/profiles.json）
//
// 和共享记忆（memory.db）的分工：
//   · 共享记忆是「一条条事实/偏好」，跨聊天按 scope 注入；
//   · 档案是「这个人/这个群是谁」的结构化速览：称呼、性格标签、已知事实、群概况。
//     私聊注入对方的档案；群里注入群概况 + 最近说话那几个人（最多 3 个）的档案。
//
// 隐私：
//   · 档案只存「谁在什么语境下说过/表现出的东西」，来源记录在 sourceKey；
//   · 命中 SENSITIVE_RE 的字段直接丢弃；sanitize 会先把已知令牌打码；
//   · 单人 facts ≤30 条、traits ≤12 条，字段 ≤160 字；总人数 ≤200（按 updatedAt LRU 淘汰）。
import fs from 'node:fs';
import path from 'node:path';

const MAX_PEOPLE = 200;
const MAX_GROUPS = 100;
const MAX_TRAITS = 12;
const MAX_FACTS = 30;
const MAX_FIELD = 160;
const MAX_ALIASES = 6;
const MAX_MEMBERS = 60;

const truncate = (s, n = MAX_FIELD) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const uniqList = (list, { max, field = MAX_FIELD } = {}) => {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const t = truncate(raw, field);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
};

const emptyStore = () => ({ version: 1, people: {}, groups: {}, updatedAt: 0 });

export function createProfiles({
  filePath,
  log = () => {},
  sanitize = (t) => String(t ?? ''),
  isSensitive = () => false
} = {}) {
  let store = null;
  let broken = null;

  function load() {
    if (store) return store;
    if (broken) return emptyStore();
    try {
      if (fs.existsSync(filePath)) {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        store = {
          version: 1,
          people: raw?.people && typeof raw.people === 'object' ? raw.people : {},
          groups: raw?.groups && typeof raw.groups === 'object' ? raw.groups : {},
          updatedAt: Number(raw?.updatedAt) || 0
        };
      } else {
        store = emptyStore();
      }
      return store;
    } catch (error) {
      broken = error?.message ?? String(error);
      log(`⚠️ 人物档案读取失败（本次运行内不再重试）：${broken}`);
      store = emptyStore();
      return store;
    }
  }

  function save() {
    if (broken) return false;
    try {
      const data = load();
      data.updatedAt = Date.now();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
      return true;
    } catch (error) {
      broken = error?.message ?? String(error);
      log(`⚠️ 人物档案写入失败（本次运行内不再写入）：${broken}`);
      return false;
    }
  }

  const clean = (text) => {
    const t = truncate(sanitize(String(text ?? '')));
    if (!t) return '';
    return isSensitive(t) ? '' : t;
  };

  const normalizeQQ = (qq) => String(qq ?? '').replace(/[^\d]/g, '').slice(0, 15);

  function personOf(qq) {
    const id = normalizeQQ(qq);
    if (!id) return null;
    const data = load();
    return data.people[id] ? { qq: id, ...data.people[id] } : null;
  }

  function groupOf(gid) {
    const id = normalizeQQ(gid);
    if (!id) return null;
    const data = load();
    return data.groups[id] ? { gid: id, ...data.groups[id] } : null;
  }

  function privacy() {
    const data = load();
    // 超额就按 updatedAt 淘汰（档案是速览，旧的不如新的有用）
    for (const [bucket, max] of [['people', MAX_PEOPLE], ['groups', MAX_GROUPS]]) {
      const ids = Object.keys(data[bucket]);
      if (ids.length <= max) continue;
      ids.sort((a, b) => (data[bucket][a].updatedAt || 0) - (data[bucket][b].updatedAt || 0));
      for (const id of ids.slice(0, ids.length - max)) delete data[bucket][id];
    }
  }

  /**
   * 更新/新建一个人物档案（合并语义：traits/facts 追加去重，name/aliases 用新值覆盖旧的）。
   * @returns {{ok:true, person:object} | {ok:false, error:string}}
   */
  function updatePerson({ qq, name, aliases, traits, facts, sourceKey } = {}) {
    const id = normalizeQQ(qq);
    if (!id) return { ok: false, error: 'qq 必须是数字 QQ 号' };
    const data = load();
    const prev = data.people[id] || { name: '', aliases: [], traits: [], facts: [], sourceKey: '', updatedAt: 0 };
    const nextName = name !== undefined ? clean(name) : prev.name;
    const next = {
      name: nextName || prev.name,
      aliases: uniqList([...((aliases ?? []).map(clean).filter(Boolean)), ...(prev.aliases ?? [])], { max: MAX_ALIASES }),
      traits: uniqList([...((traits ?? []).map(clean).filter(Boolean)), ...(prev.traits ?? [])], { max: MAX_TRAITS }),
      facts: uniqList([...((facts ?? []).map(clean).filter(Boolean)), ...(prev.facts ?? [])], { max: MAX_FACTS }),
      sourceKey: truncate(sourceKey ?? prev.sourceKey ?? '', 80),
      updatedAt: Date.now()
    };
    if (!next.name && !next.traits.length && !next.facts.length && !next.aliases.length) {
      return { ok: false, error: '没有可写入的内容（name/traits/facts 至少给一个）' };
    }
    data.people[id] = next;
    privacy();
    if (!save()) return { ok: false, error: broken || '档案写入失败' };
    return { ok: true, person: { qq: id, ...next } };
  }

  function updateGroup({ gid, name, summary, members } = {}) {
    const id = normalizeQQ(gid);
    if (!id) return { ok: false, error: 'gid 必须是数字群号' };
    const data = load();
    const prev = data.groups[id] || { name: '', summary: [], members: {}, updatedAt: 0 };
    const nextMembers = { ...(prev.members ?? {}) };
    for (const m of Array.isArray(members) ? members : []) {
      const qq = normalizeQQ(m?.qq ?? m?.userId);
      const label = clean(m?.name ?? m?.nickname ?? '');
      if (qq && label) nextMembers[qq] = label;
    }
    // 成员表按加入顺序保留最近 60 个
    const memberKeys = Object.keys(nextMembers);
    if (memberKeys.length > MAX_MEMBERS) {
      for (const k of memberKeys.slice(0, memberKeys.length - MAX_MEMBERS)) delete nextMembers[k];
    }
    const next = {
      name: (name !== undefined ? clean(name) : prev.name) || prev.name,
      summary: uniqList([...((summary ?? []).map(clean).filter(Boolean)), ...(prev.summary ?? [])], { max: 12, field: 200 }),
      members: nextMembers,
      updatedAt: Date.now()
    };
    if (!next.name && !next.summary.length && !Object.keys(nextMembers).length) {
      return { ok: false, error: '没有可写入的内容（name/summary/members 至少给一个）' };
    }
    data.groups[id] = next;
    privacy();
    if (!save()) return { ok: false, error: broken || '档案写入失败' };
    return { ok: true, group: { gid: id, ...next } };
  }

  function remove({ qq, gid } = {}) {
    const data = load();
    let removed = 0;
    if (qq) { const id = normalizeQQ(qq); if (data.people[id]) { delete data.people[id]; removed += 1; } }
    if (gid) { const id = normalizeQQ(gid); if (data.groups[id]) { delete data.groups[id]; removed += 1; } }
    if (removed) save();
    return { ok: true, removed };
  }

  const personLine = (p) => {
    const bits = [];
    if (p.name) bits.push(p.name);
    if (p.aliases?.length) bits.push(`也叫${p.aliases.slice(0, 3).join('/')}`);
    if (p.traits?.length) bits.push(`性格：${p.traits.slice(0, 6).join('、')}`);
    if (p.facts?.length) bits.push(`已知：${p.facts.slice(0, 6).join('；')}`);
    return bits.length ? `- ${bits.join('｜')}（QQ ${p.qq}）` : '';
  };

  const groupLine = (g) => {
    const bits = [];
    if (g.name) bits.push(`「${g.name}」`);
    if (g.summary?.length) bits.push(g.summary.slice(0, 4).join('；'));
    const memberNames = Object.values(g.members ?? {}).slice(0, 8);
    if (memberNames.length) bits.push(`常出现：${memberNames.join('、')}`);
    return bits.length ? `- 群 ${g.gid} ${bits.join('｜')}` : '';
  };

  /**
   * 生成注入文本：
   *   private:QQ  → 对方档案
   *   group:GID   → 群档案 + 最近说话的人（recentSenders 里的 QQ，最多 3 个）档案
   */
  function formatFor(key, { recentSenders = [], maxChars = 700 } = {}) {
    const k = String(key ?? '');
    const lines = [];
    if (k.startsWith('private:')) {
      const p = personOf(k.slice(8));
      if (p) { const line = personLine(p); if (line) lines.push(line); }
    } else if (k.startsWith('group:')) {
      const gid = k.slice(6);
      const g = groupOf(gid);
      if (g) { const line = groupLine(g); if (line) lines.push(line); }
      const seen = new Set();
      for (const sender of recentSenders) {
        const id = normalizeQQ(sender);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const p = personOf(id);
        if (!p) continue;
        const line = personLine(p);
        if (line) lines.push(line);
        if (lines.length >= 4) break;
      }
    }
    if (!lines.length) return '';
    let text = '';
    for (const line of lines) {
      if (text.length + line.length + 1 > maxChars) break;
      text += `${line}\n`;
    }
    if (!text) return '';
    return `【人物与群档案】\n${text.trimEnd()}`;
  }

  function list() {
    const data = load();
    return {
      ok: true,
      people: Object.entries(data.people).map(([qq, p]) => ({ qq, ...p })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
      groups: Object.entries(data.groups).map(([gid, g]) => ({ gid, ...g })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    };
  }

  function stats() {
    const data = load();
    return { ok: true, people: Object.keys(data.people).length, groups: Object.keys(data.groups).length, updatedAt: data.updatedAt || 0, broken: broken || null };
  }

  return { updatePerson, updateGroup, personOf, groupOf, remove, formatFor, list, stats, _filePath: filePath };
}