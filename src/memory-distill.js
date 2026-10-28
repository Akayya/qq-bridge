// 记忆自动提炼：把聊天里那些「以后还用得上」的句子挑出来，变成共享记忆。
//
// 设计取舍：这里**不额外调用模型**（那会烧一轮 token、还得等 DSH 起会话）。
// 用规则 + 句式定位来做「候选提取」，再由桥接按分值决定要不要落库：
//   · 偏好 / 关系 / 约定  → 允许自动落库（每轮最多 2 条）；
//   · 事实类             → 默认只进预览，人工确认后再写（regex 判断力有限，宁缺毋滥）。
// 模型自己也能用 qq_memory_distill 主动触发一次，看到预览再决定要不要 apply。
import { MEMORY_KINDS } from './shared-memory.js';

export const DISTILL_RULES = [
  { id: 'preference', kind: 'preference', label: '偏好', auto: true,
    re: /(我|俺|咱)(最|超|特别|挺|很|一般|平时)?(喜欢|爱|讨厌|烦|不吃|不喝|不碰|只喝|只吃|习惯|受不了|偏好|迷上)/u },
  { id: 'bond', kind: 'bond', label: '关系', auto: true,
    re: /(我(的)?(老婆|老公|对象|女朋友|男朋友|妈|爸|哥|姐|弟|妹|儿子|女儿|闺女|同事|老板|室友|朋友|同桌|师父|师傅))|我养了|我家(有|养)/u },
  { id: 'rule', kind: 'rule', label: '约定', auto: true,
    re: /(以后|下次|别再|不要(再)?|记得|答应|说好了|约定|不准|必须|每次)/u },
  { id: 'fact', kind: 'fact', label: '事实', auto: false,
    re: /(我(是|在|住|叫|今年|做|干)|生日|(\d{1,3})岁|住在|工作在|在.{2,10}(上班|工作|上学)|毕业|大学|高中|初中|老家)/u }
];

const AUTO_MAX_PER_RUN = 2;
const PREVIEW_MAX = 8;
const MIN_LEN = 6;
const MAX_LEN = 160;

const normalize = (s) => String(s ?? '')
  .replace(/\[[^\]]*\]/g, ' ')
  .replace(/[\s\p{P}\p{S}]+/gu, '')
  .toLowerCase();

/** 把一段话按句号/问号/换行拆句，挑出命中规则的那一句 */
function pickSentence(text, re) {
  const raw = String(text ?? '')
    .replace(/^(\s*@\S+\s*)+/u, '')
    .replace(/^\[[^\]]*\][^\n]*\n/, '')
    .trim();
  if (!raw) return '';
  const parts = raw.split(/[。！？!?；;\n]+/u).map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    if (re.test(part) && part.length >= MIN_LEN) return part;
  }
  return '';
}

const similar = (a, b) => {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= y.length ? x.includes(y) : y.includes(x)) {
    return Math.min(x.length, y.length) / Math.max(x.length, y.length) > 0.35;
  }
  return false;
};

/**
 * 从消息里抽候选。
 * @param {{messages:Array<{text?:string,isSelf?:boolean,senderName?:string}>, existing?:string[], key?:string, max?:number}} args
 */
export function extractCandidates({ messages = [], existing = [], key = '', max = PREVIEW_MAX } = {}) {
  const out = [];
  const seen = [];
  for (const m of messages) {
    if (!m || m.isSelf) continue;
    const text = String(m.text || m.plain || m.tail || '');
    if (text.length < MIN_LEN) continue;
    for (const rule of DISTILL_RULES) {
      const sentence = pickSentence(text, rule.re);
      if (!sentence) continue;
      if (sentence.length > MAX_LEN) continue;
      if (seen.some((s) => similar(s, sentence))) continue;
      if (existing.some((e) => similar(e, sentence))) continue;
      seen.push(sentence);
      out.push({
        kind: rule.kind,
        label: rule.label,
        auto: rule.auto,
        text: sentence,
        sourceSeq: m.seq ?? null,
        senderName: m.senderName || m.sender || ''
      });
      break;   // 一条消息只归一条规则，优先靠前的（偏好 > 关系 > 约定 > 事实）
    }
    if (out.length >= max) break;
  }
  return out;
}

export function createDistiller({
  memory,
  log = () => {},
  sanitize = (t) => String(t ?? ''),
  isSensitive = () => false,
  autoKinds = ['preference', 'bond', 'rule']
} = {}) {
  /** 预览：只算不写 */
  function preview({ key, messages, existing = [], max = PREVIEW_MAX } = {}) {
    const clean = [];
    for (const candidate of extractCandidates({ messages, existing, key, max })) {
      const text = String(sanitize(candidate.text) ?? '').trim();
      if (!text) continue;
      if (isSensitive(text)) continue;
      clean.push({ ...candidate, text });
    }
    return { ok: true, key, candidates: clean, count: clean.length };
  }

  /** 落库：默认只写 autoKinds 里的类别，最多 2 条 */
  function apply({ key, candidates = [], existing = [], includeFacts = false, max = AUTO_MAX_PER_RUN } = {}) {
    if (!memory) return { ok: false, error: '共享记忆不可用', written: [] };
    const allowed = new Set(includeFacts ? MEMORY_KINDS : autoKinds);
    const written = [];
    const skipped = [];
    for (const candidate of candidates) {
      if (written.length >= max) { skipped.push({ text: candidate.text, reason: '本轮已达上限' }); continue; }
      if (!allowed.has(candidate.kind)) { skipped.push({ text: candidate.text, reason: '该类别只进预览' }); continue; }
      if (existing.some((e) => similar(e, candidate.text))) { skipped.push({ text: candidate.text, reason: '已有相似条目' }); continue; }
      const r = memory.append({
        kind: candidate.kind,
        text: candidate.text,
        sourceKey: key,
        tags: ['自动提炼']
      });
      if (r.ok) written.push({ id: r.id, kind: r.kind, text: r.text });
      else skipped.push({ text: candidate.text, reason: r.error });
    }
    if (written.length) log(`自动提炼：${key} 新增 ${written.length} 条（${written.map((w) => w.kind).join('/')}）`);
    return { ok: true, key, written, skipped };
  }

  return { preview, apply, extract: extractCandidates };
}