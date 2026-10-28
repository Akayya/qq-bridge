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
// 检索：第一步只用 SQL 顺序取（按 used_at 最近优先），FTS5 留到第二步。
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

  /**
   * 生成注入文本（≤800 字 / ≤20 条），并把被注入的条目 used_at 推进（LRU）。
   * 返回空串表示这个会话没有任何可见条目。
   */
  function injectFor(key, { maxEntries = DEFAULT_INJECT_ENTRIES, maxChars = DEFAULT_INJECT_CHARS } = {}) {
    const conn = open();
    if (!conn) return '';
    const entries = listFor(key, { limit: maxEntries });
    if (!entries.length) return '';

    const lines = [];
    let chars = 0;
    const touched = [];
    for (const e of entries) {
      const label = KIND_LABEL[e.kind] || '记录';
      let line = `- ${e.text}`;
      if (e.scope === 'all' || e.scope === 'groups') line += `（${label}）`;
      if (chars + line.length > maxChars) break;
      lines.push(line);
      chars += line.length + 1;
      touched.push(e.id);
    }
    if (!lines.length) return '';
    if (touched.length) {
      const now = Date.now();
      const upd = conn.prepare('UPDATE memories SET used_at = ?, hits = hits + 1 WHERE id = ?');
      for (const id of touched) upd.run(now, id);
    }
    return `【共享记忆】这些是你在别的聊天里也适用的长期记忆（${lines.length} 条，来自以往交流）：\n${lines.join('\n')}`;
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

  return { append, listFor, injectFor, remove, stats, importMany, close, scopeMatches, _dbPath: dbPath };
}