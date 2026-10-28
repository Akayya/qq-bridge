// 大肥鱼表情包（dsh-nekowhale-stickers 插件）接入层。
//
// 插件在 DSH 里给 agent 装了 sticker_search / sticker_send / meme_render，但它的返回值是
// **给网页界面看的 Markdown 图片行**；QQ 桥接这边只发纯文本，如果原样转发，用户看到的
// 就是一行 `名字` 加一句“把上面这行原样放进回复即可显示。”。本模块把回复里的表情标记
// 挑出来，交还本地 GIF 路径，由 bridge.js 用图片段单独发一条。
//
// 认三种写法（其余一律原样保留，绝不吞掉模型说的话）：
//   · [sticker:名字] / [sticker:开心]              插件文档约定的桥接标记；情绪词随机取一张
//   · ![名字](http://127.0.0.1:60019/nekowhale/s/<hash>.gif)   sticker_send 返回的图片行
//   · ![标题](http://127.0.0.1:60019/nekowhale/r/<id>.gif)     meme_render 生成的模板表情
//
// 数据目录默认落在桥接自己的 state/ 下（而不是用户的 ~/.nekowhale-stickers）：
// 桥接常常在受限的沙箱里跑，往用户主目录写文件会 EPERM；而且它只需要自己发出去的那几张，
// 没必要把 322 张全量同步一遍。
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** `[sticker:REF]`；REF 是表情名，或“开心”这类情绪词。插件自己用的是同一个形状。 */
const MARK_RE = /\[sticker:([^\]\n]{1,80})\]/gu;
/** Markdown 图片行。候选长度必须有界：模型被诱导连续输出 `![` 时不能退化成 O(n²)。 */
const IMAGE_RE = /!\[([^\]\n]{0,500})\]\(([^)\s]{1,2000})\)/gu;
/** 插件把表情挂在 `{routePath=$(/nekowhale)}/(s|r)/<key>.gif` 上（见插件的 lib/index.js link()）。 */
const ROUTE_RE = /\/(s|r)\/([A-Za-z0-9_-]{1,80})\.gif/iu;
/** 解析过程中占位，解析完再决定“换成表情”还是“把原文还回去”。 */
const PLACEHOLDER_RE = /\[\[STK:(\d+)\]\]/gu;
/** 插件在图片行后面补的一句说明，对 QQ 用户毫无意义，跟着表情一起丢掉。 */
export const STICKER_NOISE_LINES = new Set(['把上面这行原样放进回复即可显示。']);
export const PLUGIN_PACKAGE_NAME = 'dsh-nekowhale-stickers';
/** 一条回复最多发几张表情：模型偶尔会连写一串标记，别把聊天糊满。 */
export const MAX_STICKERS_PER_REPLY = 3;

/** 从 URL 里认出本机绝对路径（`file://` 或 `C:\...`）。 */
export function localPathFromUrl(url) {
  const s = String(url ?? '').trim();
  if (!s) return null;
  if (s.toLowerCase().startsWith('file://')) {
    try {
      return fileURLToPath(s);
    } catch {
      return null;
    }
  }
  if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\')) return s;
  return null;
}

/**
 * 把一行 Markdown 图片归类。
 * @returns {{kind:'hash'|'render'|'local', key?:string, path?:string, alt:string}|null}
 *          null = 不是表情图片，保持原样。
 */
export function classifyImage(alt, url) {
  const match = ROUTE_RE.exec(String(url ?? ''));
  if (match) {
    const mode = match[1].toLowerCase();
    return { kind: mode === 's' ? 'hash' : 'render', key: match[2], alt: String(alt ?? '') };
  }
  const local = localPathFromUrl(url);
  if (local) return { kind: 'local', path: local, alt: String(alt ?? '') };
  return null;
}

/** 去掉表情留下的空壳：插件那句说明、行尾空格、多余空行。 */
export function cleanupStickerText(text) {
  const lines = String(text ?? '').split('\n');
  const kept = [];
  for (const line of lines) {
    if (STICKER_NOISE_LINES.has(line.trim())) continue;
    kept.push(line.replace(/[ \t]+$/, ''));
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 候选插件目录：profile 的 node_modules（dsh plugin add 的落点）→ ~/.dsh/plugins → ~/.dsh/node_modules。 */
export function pluginCandidates({ dshHome, profile } = {}) {
  const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const profiles = profile ? [profile] : ['desktop', 'web'];
  const out = [];
  for (const name of profiles) out.push(path.join(home, 'profiles', name, 'node_modules', PLUGIN_PACKAGE_NAME));
  out.push(path.join(home, 'plugins', PLUGIN_PACKAGE_NAME));
  out.push(path.join(home, 'node_modules', PLUGIN_PACKAGE_NAME));
  return out;
}

/** 找到真正装好的插件目录（必须带 lib/core/index.js，否则不是完整包）。 */
export function resolvePluginDir({ dshHome, profile, explicit } = {}) {
  const candidates = explicit ? [explicit, ...pluginCandidates({ dshHome, profile })] : pluginCandidates({ dshHome, profile });
  for (const dir of candidates) {
    if (!dir) continue;
    if (existsSync(path.join(dir, 'lib', 'core', 'index.js'))) return dir;
  }
  return null;
}

/**
 * 造一个解析器。首次用到时才 import 插件（import 会读 300+ KB 知识库，启动阶段不必付这个代价）。
 * @param {object} options
 * @param {string} [options.pluginDir] 插件目录；不给就自动找
 * @param {string} [options.dataDir]  图片缓存目录（默认 process.cwd()/state/nekowhale）
 * @param {string} [options.dshHome]  DSH_HOME
 * @param {string} [options.profile]  DSH profile 名
 * @param {'lazy'|'startup'|'off'} [options.autoSync]
 * @param {(msg:string, level?:string)=>void} [options.log]
 */
export function createNekowhaleStickers(options = {}) {
  const dataDir = options.dataDir || path.join(process.cwd(), 'state', 'nekowhale');
  const log = typeof options.log === 'function' ? options.log : null;
  const autoSync = options.autoSync || 'lazy';
  let kitPromise = null;
  let resolvedDir = options.pluginDir || null;

  function pluginDir() {
    if (!resolvedDir) resolvedDir = resolvePluginDir({ dshHome: options.dshHome, profile: options.profile });
    if (!resolvedDir) {
      throw new Error(`${PLUGIN_PACKAGE_NAME} 未安装（找过 ${pluginCandidates({ dshHome: options.dshHome, profile: options.profile }).join('、')}）`);
    }
    return resolvedDir;
  }

  function getKit() {
    if (!kitPromise) {
      kitPromise = (async () => {
        const dir = pluginDir();
        const mod = await import(pathToFileURL(path.join(dir, 'lib', 'core', 'index.js')).href);
        const kit = new mod.StickerKit({
          dataDir,
          bundledMeta: path.join(dir, 'meta', 'nekowhale.json'),
          autoSync,
          ...(log ? { log: (msg, level) => log(`[sticker] ${msg}`, level) } : {})
        });
        await kit.ready();
        return kit;
      })().catch((error) => {
        kitPromise = null; // 下次重试：插件可能刚装好、或者网络刚恢复
        throw error;
      });
    }
    return kitPromise;
  }

  async function resolveJob(job) {
    if (job.kind === 'local') {
      if (!existsSync(job.path)) throw new Error('图片文件不存在');
      return { name: job.alt || path.basename(job.path), path: job.path };
    }
    const kit = await getKit();
    if (job.kind === 'render') {
      const file = path.join(dataDir, 'renders', `${job.key}.gif`);
      if (!existsSync(file)) throw new Error('模板表情还没生成（可能不是这个 profile 渲染的）');
      return { name: job.alt || `render-${job.key}`, path: file };
    }
    if (job.kind === 'hash') {
      const all = await kit.all(false);
      const sticker = all.find((s) => s.hash === job.key);
      if (!sticker) throw new Error(`知识库里没有 hash=${job.key} 的表情`);
      const { path: file } = await kit.file(sticker);
      return { name: sticker.name || sticker.stem, path: file };
    }
    // [sticker:REF]：名字优先，其次情绪词随机
    const sticker = await kit.pick(String(job.ref));
    if (!sticker) return null; // 未知名字：原样还给模型，别吞掉
    const { path: file } = await kit.file(sticker);
    return { name: sticker.name || sticker.stem, path: file };
  }

  /**
   * 拆一段回复。
   * @param {string} text 模型回复原文
   * @returns {Promise<{text:string, stickers:Array<{name:string, path:string}>}>}
   *          text 是去掉表情标记、可直接发 QQ 的正文；stickers 按出现顺序排列。
   */
  async function digest(text) {
    const source = String(text ?? '');
    if (!source.trim()) return { text: source, stickers: [] };
    const jobs = [];
    const staged = source
      .replace(IMAGE_RE, (whole, alt, url) => {
        const job = classifyImage(alt, url);
        if (!job) return whole;
        jobs.push(job);
        return `[[STK:${jobs.length - 1}]]`;
      })
      .replace(MARK_RE, (whole, ref) => {
        jobs.push({ kind: 'ref', ref: ref.trim(), raw: whole });
        return `[[STK:${jobs.length - 1}]]`;
      });
    if (jobs.length === 0) return { text: source, stickers: [] };
    const stickers = [];
    const keep = new Array(jobs.length).fill('');
    for (let i = 0; i < jobs.length; i += 1) {
      const job = jobs[i];
      try {
        const sticker = await resolveJob(job);
        if (!sticker) {
          keep[i] = job.raw ?? ''; // 未知名字：原文保留，别吞掉模型的话
        } else if (stickers.some((s) => s.path === sticker.path)) {
          // 同一张图在一条回复里出现多次：只发一次，剩下的占位直接抹掉。
        } else if (stickers.length >= MAX_STICKERS_PER_REPLY) {
          log?.(`[sticker] 一条回复里超过 ${MAX_STICKERS_PER_REPLY} 张表情，多出来的忽略`, 'warn');
        } else {
          stickers.push({ ...sticker, source: job.kind });
        }
      } catch (error) {
        keep[i] = job.raw ?? '';
        log?.(`[sticker] ${job.raw ?? job.kind} 解析失败：${error?.message ?? error}`, 'warn');
      }
    }
    const restored = staged.replace(PLACEHOLDER_RE, (_, index) => keep[Number(index)] ?? '');
    return { text: cleanupStickerText(restored), stickers };
  }

  return { digest, getKit, pluginDir, dataDir };
}

/** 读表情文件字节（表情都是 GIF；上限交给调用方判断）。 */
export async function readStickerFile(file) {
  return readFile(file);
}
