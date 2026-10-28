// 跨聊天共享记忆（第一步）：长期事实 / 偏好 / 关系 / 相处规则。
//
// 与 state/social-v2.json 里的「轻量记忆」分工：
//   · 轻量记忆（activeTopics / pendingThoughts / memberImpressions）是**单个聊天**的短期上下文，
//     挂在 conversations[key] 下，24h/2h 自动过期；
//   · 这里的共享记忆是**跨聊天**的长期条目，落在独立 SQLite（state/memory.db），
//     由 scope 决定哪些聊天能看到它。
//
// 隐私红线（默认最严）：
//   · 不传 scope 时默认 `key:<来源会话>` —— 只有产生它的那个聊天看得见；
//   · `all` 只允许管理员私聊（ownerQQ 那个 private 会话）写入，别的会话写 all 会被拒；
//   · `owner` 同样只允许管理员私聊写；其它会话写会被降级成自己的 key；
//   · 命中 SENSITIVE_RE 的文本直接拒写（记忆库不该存凭据/密钥这类东西）。
//
// 检索：
//   · 注入顺序按 used_at 最近优先（LRU，最多 20 条 / 800 字）；
//   · 另有一套 FTS5（trigram 分词）索引，供 qq_memory_query(q=…) 做关键词命中；
//     中文用 trigram：≥3 个字才走 FTS，1~2 个字回退 LIKE '%q%'。
//   · 唤醒时还会用「最近几条来信」跟库里的条目比「内容字重合度」，命中就额外注入【相关记忆】，
//     这样「猫叫什么来着」能翻出半年前的「养了只猫叫年糕」。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const MEMORY_KINDS = ['fact', 'preference', 'bond', 'rule'];
const KIND_LABEL = { fact: '事实', preference: '偏好', bond: '关系', rule: '规则' };
const SCOPE_LABELS = { all: '全局', groups: '群聊通用', owner: '仅管理员私聊' };

const MAX_TEXT = 300;
const MAX_TAG = 32;
const MAX_TAGS = 5;
const MAX_TOTAL = 400;          // 库内条目硬上限，超了按 used_at 淘汰最旧
const DEFAULT_INJECT_ENTRIES = 20;
const DEFAULT_INJECT_CHARS = 800;

const truncate = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const normalizeTags = (tags) => {
  const list = Array.isArray(tags)
    ? tags
    : String(tags ?? '').split(/[,，、\s]+/);
  const out = [];
  for (const raw of list) {
    const t = truncate(raw, MAX_TAG);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
};

const parseTags = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

// 相关度比对用的高频虚词表：这些字不参与「内容字重合」判断，否则「我们还是」也能撞上。
const STOP_CHARS = new Set([...'的了着过吗呢吧啊哦呀嘛哈嗯是在有和与及就都也还又再才但而且所以因为如果虽然然后这样那样这个那个什么怎么为什么怎样多少很太更最不没别可以能够会要想觉得讲给对从到把被让使得于之其以及我们你们他们她们它们我你他她它自己这那哪谁啥']);

const contentChars = (s) => {
  const set = new Set();
  for (const ch of String(s ?? '')) {
    if (/[\u4e00-\u9fff]/.test(ch)) {
      if (!STOP_CHARS.has(ch)) set.add(ch);
    } else if (/[a-z0-9]/i.test(ch)) {
      set.add(ch.toLowerCase());
    }
  }
  return set;
};

export function createSharedMemory({
  dbPath,
  ownerQQ = null,
  log = () => {},
  sanitize = (t) => String(t ?? ''),
  isSensitive = () => false
} = {}) {
  let db = null;
  let broken = null;      // 打开失败的原因，避免每轮唤醒都重试刷日志
  let opening = false;

  const ownerKey = ownerQQ ? `private:${Number(ownerQQ)}` : '';

  function open() {
    if (db) return db;
    if (broken) return null;
    if (opening) return null;   // 递归调用（sanitize 里又碰记忆）时别死循环
    opening = true;
    try {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const conn = new DatabaseSync(dbPath);
      conn.exec(`
        PRAGMA journal_mode = DELETE;
        CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          text TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '',
          scope TEXT NOT NULL,
          source_key TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          used_at INTEGER NOT NULL,
          hits INTEGER NOT NULL DEFAULT 0,
          UNIQUE(text, scope)
        );
        CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
        CREATE INDEX IF NOT EXISTS idx_memories_used ON memories(used_at DESC);
      `);
      // FTS5 外部内容表：索引直接引用 memories 的行，靠触发器同步。
      // 用 trigram 分词（SQLite ≥3.34），中文不需要先切词；查询 <3 字时调用方回退 LIKE。
      const hadFts = Number(conn.prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'memories_fts'"
      ).get()?.n ?? 0);
      conn.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          text, tags, content='memories', content_rowid='id', tokenize='trigram'
        );
        CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories
        WHEN old.text IS NOT new.text OR old.tags IS NOT new.tags BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
          INSERT INTO memories_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags);
        END;
      `);
      // 老库第一次升级：把已有条目灌进索引
      if (!hadFts) {
        conn.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')");
        log('共享记忆：已为 SQLite 建 FTS5 索引（trigram）并回填历史条目');
      }
      db = conn;
      return db;
    } catch (error) {
      broken = error?.message ?? String(error);
      log(`⚠️ 共享记忆库打开失败（本次运行内不再重试）：${broken}`);
      return null;
    } finally {
      opening = false;
    }
  }

  /** 判断某个 scope 对某个会话是否可见 */
  function scopeMatches(scope, key) {
    const s = String(scope || '');
    if (s === 'all') return true;
    if (s === 'groups') return key.startsWith('group:');
    if (s === 'owner') return !!ownerKey && key === ownerKey;
    if (s.startsWith('key:')) return s.slice(4) === key;
    return false;
  }

  /**
   * 决定这次写入的最终 scope（不合法就抛错，由调用方转成 4xx）。
   * trusted=true 只给「管理员在本机跑的脚本」用（如一次性导入）：允许从任意会话写 owner 作用域。
   */
  function resolveScope(requested, sourceKey, trusted = false) {
    const raw = String(requested ?? '').trim();
    const isOwner = !!ownerKey && sourceKey === ownerKey;
    if (!raw) return { scope: `key:${sourceKey}` };
    if (raw === 'all') {
      if (!isOwner && !trusted) throw new Error('只有管理员私聊能写「全局」记忆（scope=all）；其它会话请用 groups 或省略 scope');
      return { scope: 'all' };
    }
    if (raw === 'owner') {
      if (!isOwner && !trusted) return { scope: `key:${sourceKey}`, downgradedFrom: 'owner' };
      return { scope: 'owner' };
    }
    if (raw === 'groups') return { scope: 'groups' };
    if (raw.startsWith('key:')) {
      const target = raw.slice(4);
      if (target !== sourceKey) throw new Error('scope=key:… 只能指向当前会话自己，不能替别的聊天写记忆');
      return { scope: `key:${sourceKey}` };
    }
    throw new Error('scope 只能是 all / groups / owner / key:<会话key>，或省略（默认只有本会话可见）');
  }

  function prune(conn) {
    const row = conn.prepare('SELECT COUNT(*) AS n FROM memories').get();
    const extra = Number(row?.n ?? 0) - MAX_TOTAL;
    if (extra > 0) {
      conn.prepare(`DELETE FROM memories WHERE id IN (
        SELECT id FROM memories ORDER BY used_at ASC, id ASC LIMIT ?
      )`).run(extra);
    }
  }

  /**
   * 写入一条共享记忆。
   * @returns {{ok:true, id:number, scope:string, downgradedFrom?:string, text:string} | {ok:false, error:string}}
   */
  function append({ kind, text, scope, sourceKey, tags, trusted = false } = {}) {
    const conn = open();
    if (!conn) return { ok: false, error: '共享记忆库不可用' };
    const key = String(sourceKey ?? '').trim();
    if (!key) return { ok: false, error: 'sourceKey 不能为空' };

    let finalScope;
    let downgradedFrom;
    try {
      const r = resolveScope(scope, key, trusted === true);
      finalScope = r.scope;
      downgradedFrom = r.downgradedFrom;
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }

    const body = truncate(sanitize(String(text ?? '')), MAX_TEXT);
    if (!body) return { ok: false, error: '记忆内容不能为空' };
    if (isSensitive(body)) return { ok: false, error: '记忆内容含敏感信息（凭据/密钥等），已拒绝写入' };

    const k = MEMORY_KINDS.includes(String(kind)) ? String(kind) : 'fact';
    const tagList = normalizeTags(tags);
    const now = Date.now();
    try {
      const stmt = conn.prepare(`
        INSERT INTO memories (kind, text, tags, scope, source_key, created_at, used_at, hits)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(text, scope) DO UPDATE SET
          kind = excluded.kind,
          tags = excluded.tags,
          used_at = excluded.used_at
      `);
      stmt.run(k, body, tagList.join(','), finalScope, key, now, now);
      const row = conn.prepare('SELECT id, hits FROM memories WHERE text = ? AND scope = ?').get(body, finalScope);
      prune(conn);
      return { ok: true, id: Number(row?.id ?? 0), scope: finalScope, downgradedFrom, kind: k, text: body };
    } catch (error) {
      return { ok: false, error: `写入失败：${error?.message ?? error}` };
    }
  }

  /** 列出对某个会话可见的条目（不 touch used_at） */
  function listFor(key, { limit = 50 } = {}) {
    const conn = open();
    if (!conn) return [];
    const rows = conn.prepare('SELECT * FROM memories ORDER BY used_at DESC, id DESC').all();
    return rows.filter((r) => scopeMatches(r.scope, key)).slice(0, Math.max(1, Number(limit) || 50)).map((r) => ({
      id: Number(r.id),
      kind: r.kind,
      text: r.text,
      tags: parseTags(r.tags),
      scope: r.scope,
      sourceKey: r.source_key,
      createdAt: Number(r.created_at),
      usedAt: Number(r.used_at),
      hits: Number(r.hits)
    }));
  }

  /** 选出本轮要注入的条目（纯计算，不动 used_at） */
  function pickEntries(key, { maxEntries = DEFAULT_INJECT_ENTRIES, maxChars = DEFAULT_INJECT_CHARS } = {}) {
    const entries = listFor(key, { limit: maxEntries });
    const lines = [];
    const ids = [];
    let chars = 0;
    for (const e of entries) {
      const label = KIND_LABEL[e.kind] || '记录';
      let line = `- ${e.text}`;
      if (e.scope === 'all' || e.scope === 'groups') line += `（${label}）`;
      if (chars + line.length > maxChars) break;
      lines.push(line);
      chars += line.length + 1;
      ids.push(e.id);
    }
    return { lines, ids };
  }

  function touch(conn, ids) {
    if (!ids?.length) return;
    const now = Date.now();
    const upd = conn.prepare('UPDATE memories SET used_at = ?, hits = hits + 1 WHERE id = ?');
    for (const id of ids) upd.run(now, id);
  }

  /**
   * 生成注入文本（≤800 字 / ≤20 条），并把被注入的条目 used_at 推进（LRU）。
   * 返回空串表示这个会话没有任何可见条目。
   */
  function injectFor(key, { maxEntries = DEFAULT_INJECT_ENTRIES, maxChars = DEFAULT_INJECT_CHARS } = {}) {
    const conn = open();
    if (!conn) return '';
    const { lines, ids } = pickEntries(key, { maxEntries, maxChars });
    if (!lines.length) return '';
    touch(conn, ids);
    return `【共享记忆】这些是你在别的聊天里也适用的长期记忆（${lines.length} 条，来自以往交流）：\n${lines.join('\n')}`;
  }

  const MIN_FTS = 3;
  const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
  const toEntry = (r) => ({
    id: Number(r.id),
    kind: r.kind,
    text: r.text,
    tags: parseTags(r.tags),
    scope: r.scope,
    sourceKey: r.source_key,
    createdAt: Number(r.created_at),
    usedAt: Number(r.used_at),
    hits: Number(r.hits)
  });

  /**
   * 关键词检索（给 qq_memory_query 用）：≥3 字走 FTS5 trigram，1~2 字回退 LIKE。
   * 结果同样按 scope 过滤，命中会推进 used_at/hits。
   */
  function search(query, { key, limit = 10 } = {}) {
    const conn = open();
    if (!conn) return [];
    const q = String(query ?? '').replace(/\s+/g, ' ').trim();
    if (!q || !key) return [];
    const cap = Math.max(1, Math.min(50, Number(limit) || 10));
    let rows = [];
    if ([...q].length >= MIN_FTS) {
      try {
        rows = conn.prepare(`
          SELECT m.* FROM memories_fts
          JOIN memories m ON m.id = memories_fts.rowid
          WHERE memories_fts MATCH ?
          ORDER BY bm25(memories_fts), m.used_at DESC
          LIMIT ?
        `).all(`"${q.replace(/"/g, '""')}"`, cap * 4);
      } catch (error) {
        log(`⚠️ 共享记忆检索失败，回退 LIKE：${error?.message ?? error}`);
        rows = [];
      }
    }
    if (!rows.length) {
      const like = `%${likeEscape(q)}%`;
      rows = conn.prepare(`
        SELECT * FROM memories
        WHERE text LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\'
        ORDER BY used_at DESC, id DESC LIMIT ?
      `).all(like, like, cap * 4);
    }
    const hits = rows.filter((r) => scopeMatches(r.scope, key)).slice(0, cap).map(toEntry);
    touch(conn, hits.map((e) => e.id));
    return hits;
  }

  /**
   * 找出与「当前来信」相关的旧条目。
   * 不用 FTS 是因为来信是一整句，trigram 的 MATCH 要求整句命中，反而查不到；
   * 这里改成「内容字重合度」：去掉高频虚词后比较两边共有的汉字，共 ≥2 个字才算相关，
   * 再按重合度除以条目长度做归一化，避免长条目永远赢。
   */
  function relatedFor(key, text, { limit = 5, excludeIds = [] } = {}) {
    const conn = open();
    if (!conn) return [];
    const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
    if ([...raw].length < 2) return [];
    const hay = contentChars(raw);
    if (hay.size < 2) return [];
    const skip = new Set(excludeIds.map(Number));
    const rows = conn.prepare('SELECT * FROM memories ORDER BY used_at DESC').all();
    const scored = [];
    for (const r of rows) {
      if (skip.has(Number(r.id))) continue;
      if (!scopeMatches(r.scope, key)) continue;
      const t = String(r.text ?? '');
      const set = contentChars(t);
      let shared = 0;
      for (const c of set) if (hay.has(c)) shared += 1;
      if (shared < 2) continue;
      let score = shared / Math.sqrt(Math.max(4, set.size));
      for (const tag of parseTags(r.tags)) if (tag.length >= 2 && raw.includes(tag)) { score += 1.5; break; }
      scored.push({ score, entry: toEntry(r) });
    }
    scored.sort((a, b) => b.score - a.score || b.entry.usedAt - a.entry.usedAt);
    const picked = scored.slice(0, Math.max(1, Number(limit) || 5)).map((x) => x.entry);
    touch(conn, picked.map((e) => e.id));
    return picked;
  }

  /**
   * 唤醒时一次性拿到两段注入文本：
   *   text        —— 常驻的长期记忆（LRU）
   *   relatedText —— 与最近来信相关、但没被 LRU 带上的旧记忆
   */
  function injectBundle(key, { recentText = '', maxEntries, maxChars, relatedLimit = 5 } = {}) {
    const conn = open();
    if (!conn) return { text: '', relatedText: '', injectedIds: [], relatedIds: [] };
    const { lines, ids } = pickEntries(key, { maxEntries, maxChars });
    const related = relatedFor(key, recentText, { limit: relatedLimit, excludeIds: ids });
    if (lines.length) touch(conn, ids);
    const text = lines.length
      ? `【共享记忆】这些是你在别的聊天里也适用的长期记忆（${lines.length} 条，来自以往交流）：\n${lines.join('\n')}`
      : '';
    const relatedText = related.length
      ? `【相关记忆】以前聊到过、和当前话题对得上的记录（${related.length} 条）：\n${related
        .map((e) => `- ${e.text}（${KIND_LABEL[e.kind] || '记录'}）`)
        .join('\n')}`
      : '';
    return { text, relatedText, injectedIds: ids, relatedIds: related.map((e) => e.id) };
  }

  function remove({ id, text } = {}) {
    const conn = open();
    if (!conn) return { ok: false, error: '共享记忆库不可用' };
    if (id) {
      const r = conn.prepare('DELETE FROM memories WHERE id = ?').run(Number(id));
      return { ok: true, removed: Number(r.changes ?? 0) };
    }
    const t = String(text ?? '').trim();
    if (!t) return { ok: false, error: '需要 id 或 text' };
    const r = conn.prepare('DELETE FROM memories WHERE text = ?').run(t);
    return { ok: true, removed: Number(r.changes ?? 0) };
  }

  function stats() {
    const conn = open();
    if (!conn) return { ok: false, error: broken || '共享记忆库不可用' };
    const total = Number(conn.prepare('SELECT COUNT(*) AS n FROM memories').get()?.n ?? 0);
    const byScope = {};
    for (const row of conn.prepare('SELECT scope, COUNT(*) AS n FROM memories GROUP BY scope').all()) {
      const label = row.scope.startsWith('key:') ? `key:${row.scope.slice(4)}` : (SCOPE_LABELS[row.scope] || row.scope);
      byScope[label] = Number(row.n);
    }
    return { ok: true, total, byScope };
  }

  /** 供导入脚本使用：批量写入（默认落在各自的 key scope 下，不会互相串味） */
  function importMany(entries = []) {
    const conn = open();
    if (!conn) return { ok: false, error: '共享记忆库不可用', imported: 0, skipped: 0 };
    let imported = 0;
    let skipped = 0;
    const errors = [];
    for (const e of entries) {
      const r = append(e);
      if (r.ok) imported += 1;
      else { skipped += 1; errors.push(r.error); }
    }
    return { ok: true, imported, skipped, errors: errors.slice(0, 5) };
  }

  function close() {
    try { db?.close(); } catch { /* 忽略 */ }
    db = null;
  }

  return { append, listFor, injectFor, injectBundle, search, relatedFor, remove, stats, importMany, close, scopeMatches, _dbPath: dbPath };
}