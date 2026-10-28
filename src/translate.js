/**
 * 轻量翻译：把 OCR 出来的外文丢给 MyMemory 的免费接口翻成中文。
 *
 * 为什么不用 Google：本机网络下 translate.googleapis.com 直接超时（实测 aborted due to timeout），
 * lingva.ml 被 Cloudflare 挡（403）。MyMemory（api.mymemory.translated.net）实测可用，
 * 匿名每天有额度，够聊天场景用；额度用完/网络断掉时**不报错崩掉**，而是如实返回失败原因。
 *
 * 设计要点：
 *   - 分块：接口单次查询有长度上限，按句子/换行切到 480 字符以内再逐块翻。
 *   - 缓存：同一段文本重复问不重复打接口（额度宝贵）。
 *   - 可注入 fetchImpl：测试里用假 fetch，不依赖网络。
 *   - 已经全是目标语言（比如中文翻中文）时直接原样返回，不浪费额度。
 */
const MYMEMORY_ENDPOINT = 'https://api.mymemory.translated.net/get';
const MAX_CHUNK = 480;
const MAX_CHUNKS = 20;
const CACHE_LIMIT = 80;

const cache = new Map();

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const KANA_RE = /[\u3040-\u30ff]/;

/** 把常见 HTML 实体还原，MyMemory 会返回 &#39; 这类东西。 */
export function decodeEntities(input) {
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

/** 规范化语言名：zh/zh-cn/chinese → zh-CN；en/eng → en；ja/jp → ja。 */
export function normalizeLang(input, fallback = 'zh-CN') {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (/^(zh|cn|chinese|zh-cn|zh-hans|zh-sg|zh-tw|cht)/.test(raw)) return raw.includes('tw') || raw.includes('cht') ? 'zh-TW' : 'zh-CN';
  if (/^(en|eng|english)/.test(raw)) return 'en';
  if (/^(ja|jp|japanese)/.test(raw)) return 'ja';
  if (/^(ko|kr|korean)/.test(raw)) return 'ko';
  if (/^(fr|french)/.test(raw)) return 'fr';
  if (/^(de|german)/.test(raw)) return 'de';
  if (/^(es|spanish)/.test(raw)) return 'es';
  if (/^(ru|russian)/.test(raw)) return 'ru';
  return raw;
}

/** 粗略判断文本更像哪种语言（只用于"已经是目标语言就别翻了"和猜源语言）。 */
export function guessLang(text) {
  const s = String(text ?? '');
  if (KANA_RE.test(s)) return 'ja';
  if (CJK_RE.test(s)) return 'zh-CN';
  if (/[а-яА-Я]/.test(s)) return 'ru';
  return 'en';
}

/**
 * 按句子/换行切块，每块不超过 max 字符。切点优先：换行 > 。！？.!? > 空格。
 * 纯函数，方便单测。
 */
export function splitChunks(text, max = MAX_CHUNK) {
  const source = String(text ?? '').trim();
  if (!source) return [];
  if (source.length <= max) return [source];
  const out = [];
  let rest = source;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = -1;
    for (const re of [/\n/g, /[。！？；;!?]/g, /[，,、\s]/g]) {
      let m;
      let last = -1;
      while ((m = re.exec(window)) !== null) last = m.index + m[0].length;
      if (last > max * 0.4) { cut = last; break; }
    }
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * 翻译一段文本。
 * @returns {Promise<{ok:boolean,text:string,lang:string,provider:string,chunks:number,cached?:boolean,note?:string,error?:string}>}
 *         翻译失败不抛异常（返回 ok:false + error），调用方照常把原文给模型，由模型自己翻。
 */
export async function translateText(text, options = {}) {
  const {
    target = 'zh-CN',
    source = '',
    timeoutMs = 15000,
    fetchImpl = globalThis.fetch,
    maxChunks = MAX_CHUNKS
  } = options;
  const raw = String(text ?? '').trim();
  const lang = normalizeLang(target, 'zh-CN');
  if (!raw) return { ok: true, text: '', lang, provider: 'none', chunks: 0 };
  const guessed = guessLang(raw);
  if (guessed === lang) {
    return { ok: true, text: raw, lang, provider: 'none', chunks: 0, note: '原文已经是目标语言，未翻译' };
  }
  const srcLang = normalizeLang(source, '') || guessed;
  const cacheKey = `${srcLang}|${lang}|${raw}`;
  if (cache.has(cacheKey)) return { ...cache.get(cacheKey), cached: true };
  if (typeof fetchImpl !== 'function') {
    return { ok: false, text: '', lang, provider: 'none', chunks: 0, error: '当前环境没有可用的 fetch' };
  }
  const chunks = splitChunks(raw);
  const out = [];
  try {
    for (const chunk of chunks.slice(0, maxChunks)) {
      const url = `${MYMEMORY_ENDPOINT}?q=${encodeURIComponent(chunk)}&langpair=${encodeURIComponent(srcLang)}|${encodeURIComponent(lang)}`;
      const res = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) throw new Error(`翻译接口 HTTP ${res.status}`);
      const data = await res.json();
      const translated = decodeEntities(data?.responseData?.translatedText ?? '').trim();
      if (!translated) {
        throw new Error(`翻译接口返回空结果${data?.responseDetails ? `：${data.responseDetails}` : ''}`);
      }
      out.push(translated);
      // 额度接口对突发请求敏感，块间让一步。
      if (chunks.length > 1) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } catch (error) {
    return {
      ok: false,
      text: out.join('\n'),
      lang,
      provider: 'mymemory',
      chunks: chunks.length,
      error: `${error?.message ?? error}（翻译服务不可用时请自己翻译原文）`
    };
  }
  const result = {
    ok: true,
    text: out.join('\n'),
    lang,
    provider: 'mymemory',
    chunks: chunks.length,
    ...(chunks.length > maxChunks ? { note: `原文过长，只翻了前 ${maxChunks} 段` } : {})
  };
  if (cache.size > CACHE_LIMIT) cache.clear();
  cache.set(cacheKey, result);
  return result;
}

/** 测试用：清缓存。 */
export function clearTranslateCache() {
  cache.clear();
}
