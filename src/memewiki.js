/**
 * 梗百科：把 AstrBot 插件 astrbot_plugin_memewiki 的「本地词库 + 在线兜底」搬进 qq-bridge。
 *
 * 原插件是 AstrBot 的，和 DSH / qq-bridge 不兼容；但它真正值钱的是那 6660 条词条
 * （data/memes.db，SQLite，随插件分发，查询 1–3ms）和一套「先接梗、别科普」的注入文案。
 * 这里只复用数据与检索/排版逻辑，不依赖 AstrBot。
 *
 * 数据来源：
 *   - 本地：<qq-bridge>/data/memewiki/memes.db（列：title, slug, tags, usage, origin, other, summary）
 *   - 兜底：cnmeme.wiki 公开只读接口 /api/v1/public/memes?q=…
 *
 * 词条正文分「用法 / 出处 / 其它」三段，喂给模型时把「怎么用」放前面，
 * 这样模型可以直接照着接梗，而不是复述百科。
 */
import { DatabaseSync } from 'node:sqlite';

const API_BASE = 'https://cnmeme.wiki/api/v1/public/memes';
const CACHE_LIMIT = 300;
const MISS_TTL_MS = 10 * 60 * 1000;

// 唤醒词：消息开头带这些时先剥掉，避免「小鲸鱼这是什么梗」把唤醒词当查询词。
const WAKE_WORDS = ['小鲸鱼', '大鲸鱼', '大肥鲸', '小肥鲸', '大肥鱼', '奶鱼', '鲸鱼', 'deepseek', 'ds'];
// 「XX 是什么梗 / 啥意思 / 怎么用」这类提问句式。
const ASK_PATTERN = /(?:是)?(?:什么梗|啥梗|什么来头|什么来历|什么出处|什么意思|啥意思|怎么用|怎么接|怎么玩|如何用)(?:啊|呀|呢|的|来着|嘛|呗|哦|哟|吧)?[？?。！!~～]*$/u;
// 裸词：2–10 个汉字/字母/数字，不含空格标点。
const BARE_PATTERN = /^[\u4e00-\u9fa5A-Za-z0-9·]{2,10}$/u;
const STOP_WORDS = new Set([
  '在吗', '在不在', '哈哈', '哈哈哈', '笑死', '好的', '好吧', '晚安', '早安',
  '睡觉', '吃饭', '干嘛', '没事', '收到', '谢谢', '好耶', '草', '典', '乐'
]);
const PRONOUN_HEADS = new Set(['这', '那', '它', '他', '她', '这个', '那个', '你', '这句话', '那句话', '上面', '刚才', '下文', '前面']);

function clip(text, max) {
  const s = String(text ?? '').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function decodeEntities(input) {
  return String(input ?? '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** 词条 HTML → 纯文本（保留 ## 小标题结构，供 splitSections 用）。 */
export function htmlToText(raw) {
  if (!raw) return '';
  return decodeEntities(
    String(raw)
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<h([1-6])[^>]*>/gi, '\n## ')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 把词条正文按 ## 小标题拆成「用法 / 出处 / 其它」。 */
export function splitSections(text) {
  const parts = String(text ?? '').split(/\n##\s*/);
  const usage = [];
  const origin = [];
  const other = [];
  for (const partRaw of parts) {
    const part = partRaw.trim();
    if (!part) continue;
    const index = part.indexOf('\n');
    const head = (index >= 0 ? part.slice(0, index) : part).trim();
    const rest = index >= 0 ? part.slice(index + 1).trim() : '';
    if (/(用法|怎么用|如何用|例句|接梗)/.test(head)) usage.push(rest || head);
    else if (/(来源|出处|背景|起源|介绍)/.test(head)) origin.push(rest || head);
    else other.push(rest ? `${head}\n${rest}` : head);
  }
  return {
    usage: usage.join('\n').trim(),
    origin: origin.join('\n').trim(),
    other: other.join('\n').trim()
  };
}

/** 模型看的版本：怎么用在前，出处附后（出处标注「别照搬」）。 */
export function entryText(data, forLlm = true) {
  const lines = [`【梗百科】${data.title}`];
  if (data.note) lines.push(data.note);
  if (Array.isArray(data.tags) && data.tags.length) lines.push(`标签：${data.tags.join('、')}`);
  if (forLlm) {
    if (data.usage) lines.push(`【怎么用 / 怎么接】\n${clip(data.usage, 600)}`);
    if (data.origin) lines.push(`【出处（仅用于理解，别照搬）】\n${clip(data.origin, 450)}`);
  } else {
    if (data.origin) lines.push(`【来源】\n${clip(data.origin, 450)}`);
    if (data.usage) lines.push(`【用法】\n${clip(data.usage, 600)}`);
  }
  if (data.other) lines.push(clip(data.other, 400));
  if (Array.isArray(data.extra) && data.extra.length) lines.push(`同批检索到的其它相关词条：${data.extra.join('、')}`);
  lines.push(`cnmeme.wiki/词条/${data.slug || ''}`);
  return lines.join('\n');
}

/** 从一条聊天消息里判断「像不像在问梗」，抽出要查的词。 */
export function extractQuery(text, options = {}) {
  const wakeWords = options.wakeWords ?? WAKE_WORDS;
  let t = String(text ?? '').trim();
  t = t.replace(/^(?:@\S+\s*)+/u, '');
  for (const w of wakeWords) {
    if (t.startsWith(w)) {
      t = t.slice(w.length).replace(/^[ ，,。.！!？?:：]+/u, '');
      break;
    }
  }
  t = t.trim();
  if (!t) return null;
  const ask = ASK_PATTERN.exec(t);
  if (ask) {
    let head = t.slice(0, ask.index).trim().replace(/[ ，,。.！!？?]+$/u, '');
    head = head.replace(/^是/u, '').replace(/[ ，,。.！!？?]+$/u, '');
    head = head.replace(/(这个梗|那个梗|这梗|那梗|这个|那个)$/u, '').trim();
    head = head.replace(/(到底|究竟)$/u, '').trim();
    if (PRONOUN_HEADS.has(head)) return null;
    const first = head.slice(0, 1);
    if (head.length <= 2 && ['这', '那', '它', '他', '她'].includes(first)) return null;
    if (head.length > 1 && head.length <= 12) return head;
    // 像「兄弟，今天这波真是踢到铁板了，这词啥意思来着」这种长句：从各个短句里挑
    // 最长的合格候选（整句当词查必然查不到，反而不注入）。
    const clauses = head
      .split(/[，,。！!？?；;、\s]+/u)
      .map((c) => c.trim())
      .filter((c) => c.length >= 2 && c.length <= 12)
      .filter((c) => !PRONOUN_HEADS.has(c))
      .filter((c) => !/^(这|那|它|他|她|你|我)(词|话|句|意思|梗|是|个)/u.test(c))
      .sort((a, b) => b.length - a.length);
    return clauses[0] ?? null;
  }
  if (BARE_PATTERN.test(t) && !STOP_WORDS.has(t)) {
    // 叠字（哈哈哈哈 / 嘿嘿嘿 / 啊啊啊）不是梗，别去查。
    const chars = [...t];
    if (chars.length >= 3 && chars.every((c) => c === chars[0])) return null;
    if (/^(哈|嘿|嘻|呵|呜|哇|啊|呀|额|嗯|嗷|呃)+$/u.test(t)) return null;
    // 裸词里带疑问词的基本都是日常句子（「今天晚饭吃什么好呢」），不是梗词；
    // 真长这样的词条（「关我什么事」）仍可通过 qq_meme 工具或完整标题命中。
    if (/[什么咋谁哪多少]/u.test(t)) return null;
    return t;
  }
  return null;
}

/**
 * @param {object} options
 * @param {string} options.dbPath  memes.db 路径
 * @param {string} [options.apiBase]
 * @param {number} [options.timeoutMs] 在线兜底超时（默认 2500ms）
 * @param {(msg:string)=>void} [options.log]
 */
export function createMemeWiki(options = {}) {
  const {
    dbPath,
    apiBase = API_BASE,
    timeoutMs = 2500,
    log = () => {}
  } = options;
  // config.json 里 apiBase 留空（''）时也要回落到默认地址——空串不会触发默认参数，
  // 之前会拼出 "new URL('/slug')" 这种非法地址，日志里留下 `预查失败 … Invalid URL`。
  const resolvedApiBase = String(apiBase ?? '').trim() || API_BASE;
  const cache = new Map();
  const misses = new Map();
  let db = null;
  let dbError = null;

  function openDb() {
    if (db || dbError) return db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch (error) {
      dbError = error;
      log(`[memewiki] 打开词库失败（${dbPath}）：${error?.message ?? error}`);
    }
    return db;
  }

  function stats() {
    const conn = openDb();
    if (!conn) return { ok: false, error: String(dbError?.message ?? '词库不可用') };
    try {
      const count = conn.prepare("SELECT value FROM meta WHERE key = 'count'").get();
      const built = conn.prepare("SELECT value FROM meta WHERE key = 'built_at'").get();
      return { ok: true, count: Number(count?.value) || 0, builtAt: String(built?.value ?? '') };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /** 本地匹配：只认「完整标题出现在消息里」，不做前缀模糊（否则「你是什么」会命中「你是什么冠军」）。 */
  function localMatch(query) {
    const q = String(query ?? '').trim();
    if (!q) return null;
    const conn = openDb();
    if (!conn) return null;
    try {
      const exact = conn.prepare('SELECT title FROM memes WHERE title = ?').get(q);
      if (exact) return String(exact.title);
      // 只认长度 ≥2 的标题：单字标题（比如「梗」）出现在任何句子里都能命中，全是噪音。
      const contained = conn
        .prepare('SELECT title FROM memes WHERE length(title) >= 2 AND instr(?, title) > 0 ORDER BY length(title) DESC LIMIT 1')
        .get(q);
      return contained ? String(contained.title) : null;
    } catch (error) {
      log(`[memewiki] 查词库失败：${error?.message ?? error}`);
      return null;
    }
  }

  function rowData(row, query, title) {
    const tags = String(row.tags ?? '').split('、').map((s) => s.trim()).filter(Boolean);
    let usage = String(row.usage ?? '');
    let origin = String(row.origin ?? '');
    let other = String(row.other ?? '');
    if (!usage && !origin) other = other || String(row.summary ?? '');
    const note = String(title ?? '').trim() !== String(query ?? '').trim()
      ? `（没有同名条目，这条标题是「${title}」）`
      : '';
    return { title: String(title ?? row.title ?? query), tags, usage, origin, other, note, extra: [], slug: String(row.slug ?? ''), source: 'local' };
  }

  function localLookup(query) {
    const title = localMatch(query);
    if (!title) return null;
    const conn = openDb();
    if (!conn) return null;
    try {
      const row = conn
        .prepare('SELECT title, slug, tags, usage, origin, other, summary FROM memes WHERE title = ?')
        .get(title);
      return row ? rowData(row, query, title) : null;
    } catch (error) {
      log(`[memewiki] 读词库失败：${error?.message ?? error}`);
      return null;
    }
  }

  async function apiGet(url, params) {
    const target = new URL(url);
    for (const [k, v] of Object.entries(params ?? {})) target.searchParams.set(k, String(v));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(target, { signal: controller.signal, headers: { accept: 'application/json' } });
      if (!res.ok) return null;
      return await res.json();
    } catch (error) {
      log(`[memewiki] 在线接口失败：${error?.message ?? error}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function detail(slug) {
    const data = await apiGet(`${resolvedApiBase}/${encodeURIComponent(slug)}`);
    return data?.item ?? null;
  }

  async function searchOnline(query, strict) {
    const data = await apiGet(resolvedApiBase, { q: query, limit: 5 });
    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) return null;
    const q = String(query).trim();
    let picked = items.find((it) => String(it?.title ?? '').trim() === q) ?? null;
    if (!picked) {
      picked = items.find((it) => {
        const title = String(it?.title ?? '').trim();
        return title.length >= 2 && q.includes(title);
      }) ?? null;
    }
    if (!picked && strict) return null;
    let note = '';
    if (!picked) {
      picked = items[0];
      note = `（词库里没有完全同名的条目，最接近的是「${String(picked?.title ?? '')}」）`;
    } else if (String(picked.title ?? '').trim() !== q) {
      note = `（没有同名条目，这条标题是「${String(picked.title ?? '')}」）`;
    }
    const slug = String(picked.slug ?? '');
    const item = (slug ? await detail(slug) : null) ?? picked;
    const body = htmlToText(item.content_html ?? '') || String(item.summary ?? '');
    const sections = splitSections(body);
    const tags = Array.isArray(item.tags) ? item.tags.map(String) : [];
    const extra = note
      ? items
        .filter((it) => String(it?.slug ?? '') !== slug)
        .map((it) => String(it?.title ?? ''))
        .filter(Boolean)
        .slice(0, 3)
      : [];
    return {
      title: String(item.title ?? q),
      tags,
      usage: sections.usage,
      origin: sections.origin,
      other: sections.usage || sections.origin ? sections.other : body,
      note,
      extra,
      slug,
      source: 'online'
    };
  }

  /**
   * 查梗。返回 { ok, hit, text, data?, source }。
   * strict=true 时只接受明确命中的结果（预查注入用，避免把普通短句当梗）。
   */
  async function lookup(query, opts = {}) {
    const strict = opts.strict === true;
    const q = String(query ?? '').trim();
    if (!q) return { ok: false, hit: false, text: '查询词为空。' };
    const cacheKey = `${strict ? 's' : 'n'}:${q}`;
    if (cache.has(cacheKey)) return { ...cache.get(cacheKey), cached: true };
    const missAt = misses.get(cacheKey);
    if (missAt && Date.now() < missAt) {
      return { ok: true, hit: false, text: `词库里没有收录「${q}」。这可能是刚出现的新梗、群内自造词，或者拼写不对。`, source: 'miss-cache' };
    }

    let data = localLookup(q);
    if (!data) data = await searchOnline(q, strict);
    if (!data) {
      misses.set(cacheKey, Date.now() + MISS_TTL_MS);
      if (misses.size > 200) misses.clear();
      return { ok: true, hit: false, text: `词库里没有收录「${q}」。这可能是刚出现的新梗、群内自造词，或者拼写不对。`, source: 'none' };
    }
    const result = { ok: true, hit: true, text: entryText(data, true), data, source: data.source };
    if (cache.size > CACHE_LIMIT) cache.clear();
    cache.set(cacheKey, result);
    return result;
  }

  /**
   * 预查注入：消息像问梗时先查好，返回给模型看的提示段；不像/没查到返回 ''。
   * 文案照搬原插件：先接梗、别科普、别复述标题。
   */
  async function prefetchHint(messageText) {
    const query = extractQuery(messageText);
    if (!query) return '';
    try {
      const result = await lookup(query, { strict: true });
      if (!result.hit) return '';
      return [
        '[梗词库内部资料·仅用于理解，禁止原样输出]',
        `这是「${query}」的资料。**优先用这个词接梗**：照着【怎么用 / 怎么接】里的说法、动作或句式，用你自己的口气回一句；对方没明确问含义时，**不要主动解释典故**。`,
        '只有在对方明确问「这是什么梗/啥意思」，或者实在接不上时，才用一两句解释出处。',
        '不要复述标题、标签、来源，不要整段照抄，也不要说"我查了一下"。',
        '',
        result.text
      ].join('\n');
    } catch (error) {
      log(`[memewiki] 预查失败（${query}）：${error?.message ?? error}`);
      return '';
    }
  }

  function close() {
    try { db?.close(); } catch { /* ignore */ }
    db = null;
  }

  return { lookup, prefetchHint, extractQuery, stats, localMatch, close };
}
