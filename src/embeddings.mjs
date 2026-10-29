// 本地向量嵌入（语义检索用）。
//
// 为什么要单独一个模块：桥接跑在 QQ 常驻进程里，嵌入模型必须
//   · 离线（聊天内容不出本机，只有首次下载模型时联网）；
//   · 懒加载（没人用记忆的时候不要占几百 MB 内存）；
//   · 失败可降级（模型缺失/加载失败 → 返回 null，调用方自动退回 FTS + 字重合）。
//
// 依赖隔离：transformers.js + onnxruntime 装在 `vendor/embeddings/` 自己的 node_modules 里，
// 不污染桥接主依赖（主 node_modules 用 pnpm hoisted 链接，混装容易把现有依赖搞坏）。
// 首次使用会从 hf-mirror 拉 `Xenova/bge-small-zh-v1.5` 的 q8 权重（约 24 MB），
// 之后完全离线（缓存在 `state/models/`）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

export const DEFAULT_MODEL = 'Xenova/bge-small-zh-v1.5';
export const DEFAULT_VENDOR_MODULE = path.join(
  ROOT, 'vendor', 'embeddings', 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs'
);

/** 余弦相似度（两个等长向量，已归一化时等价于点积） */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * @param {object} opts
 * @param {boolean} [opts.enabled]     关闭时 available() 恒为 false，不加载任何东西
 * @param {string}  [opts.model]       HF 上的模型 id（默认 bge-small-zh-v1.5，512 维）
 * @param {string}  [opts.dtype]       q8 | fp32 | fp16（q8 体积最小，质量略降）
 * @param {string}  [opts.cacheDir]    模型缓存目录（默认 state/models）
 * @param {string}  [opts.remoteHost]  模型下载源（默认 hf-mirror，国内可直连）
 * @param {string}  [opts.modulePath]  transformers.node.mjs 的绝对路径
 */
export function createEmbedder({
  enabled = true,
  model = DEFAULT_MODEL,
  dtype = 'q8',
  cacheDir = path.join(ROOT, 'state', 'models'),
  remoteHost = 'https://hf-mirror.com',
  modulePath = DEFAULT_VENDOR_MODULE,
  log = () => {}
} = {}) {
  const state = {
    enabled: enabled !== false,
    status: 'idle',        // idle | loading | ready | failed
    error: '',
    dim: 0,
    model,
    dtype,
    cacheDir,
    loadedAt: 0,
    calls: 0,
    items: 0,
    totalMs: 0,
    lastMs: 0
  };
  let extractor = null;
  let loading = null;

  function info() {
    return {
      enabled: state.enabled,
      status: state.status,
      model: state.model,
      dtype: state.dtype,
      dim: state.dim,
      error: state.error,
      calls: state.calls,
      items: state.items,
      avgMs: state.items ? Math.round(state.totalMs / state.items) : 0,
      lastMs: state.lastMs
    };
  }

  async function load() {
    if (!state.enabled) throw new Error('向量检索未启用');
    if (extractor) return extractor;
    if (!fs.existsSync(modulePath)) {
      throw new Error(`找不到嵌入模块：${modulePath}（先跑 pnpm --dir vendor/embeddings install）`);
    }
    state.status = 'loading';
    const mod = await import(pathToFileURL(modulePath).href);
    const env = mod.env;
    // 国内直连 huggingface.co 基本不通，hf-mirror 是官方推荐的镜像。
    if (remoteHost) env.remoteHost = remoteHost;
    env.allowRemoteModels = true;
    env.allowLocalModels = false;    // 只走「下载到缓存」，避免它把仓库目录当成本地模型找
    env.useFSCache = true;
    env.cacheDir = cacheDir;
    fs.mkdirSync(cacheDir, { recursive: true });
    const t0 = Date.now();
    extractor = await mod.pipeline('feature-extraction', model, { dtype });
    state.status = 'ready';
    state.loadedAt = Date.now();
    state.error = '';
    log(`向量模型已就绪：${model}（${dtype}，加载 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
    return extractor;
  }

  function ensure() {
    if (!loading) {
      loading = load().catch((error) => {
        state.status = 'failed';
        state.error = error?.message ?? String(error);
        log(`⚠️ 向量模型加载失败（本次运行内不再重试，记忆检索退回关键词模式）：${state.error}`);
        loading = null;
        throw error;
      });
    }
    return loading;
  }

  /** 后台预热：不 await，失败也不抛 */
  function warm() {
    if (!state.enabled || state.status === 'ready' || state.status === 'failed') return Promise.resolve(false);
    return ensure().then(() => true).catch(() => false);
  }

  function available() {
    return state.enabled && state.status === 'ready';
  }

  /**
   * 把一批文本编码成向量（L2 已归一化）。
   * @returns {Promise<Float32Array[] | null>} 失败返回 null，调用方降级处理
   */
  async function embed(texts) {
    const list = (Array.isArray(texts) ? texts : [texts])
      .map((t) => String(t ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (!list.length) return [];
    if (!state.enabled) return null;
    let ex;
    try {
      ex = await ensure();
    } catch {
      return null;
    }
    const t0 = Date.now();
    try {
      const out = await ex(list, { pooling: 'mean', normalize: true });
      const rows = out.tolist();
      const vecs = rows.map((r) => Float32Array.from(r));
      if (!state.dim && vecs[0]) state.dim = vecs[0].length;
      state.calls += 1;
      state.items += vecs.length;
      state.totalMs += Date.now() - t0;
      state.lastMs = Date.now() - t0;
      return vecs;
    } catch (error) {
      state.error = error?.message ?? String(error);
      log(`⚠️ 向量计算失败：${state.error}`);
      return null;
    }
  }

  return { embed, warm, available, info, cosine, model };
}