/**
 * 图片文字识别（OCR）兜底。
 *
 * 为什么用它：QQ 图片在送进模型前会被压缩（`socialV2.media.maxModelBytes` / `maxLongEdge`），
 * 小字、长截图、聊天记录之类常常压缩后就看不清了。模型这时候可以调 `qq_ocr` 把原图再读一遍文字。
 *
 * 实现走 Windows 自带的 WinRT OCR（`Windows.Media.Ocr`）：离线、免费、不装依赖、无隐私外发，
 * 代价是只有系统装了哪门语言就认哪门（本机实测只有 `zh-Hans-CN`，足够应付中文截图）。
 * 真正的识别在 `scripts/ocr.ps1` 里，这里只负责：把 buffer 落到临时 png、spawn powershell、清洗结果。
 *
 * WinRT OCR 会把每个汉字之间都插一个空格（"识 别 测 试"），中文场景下直接把 CJK 之间的空格去掉。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPT = path.join(HERE, '..', 'scripts', 'ocr.ps1');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const CJK = '\\u2e80-\\u303f\\u3040-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
// 只吃行内空白：`\s` 会把换行也吃掉，多行文本会被粘成一行。
const RE_CJK_GAP = new RegExp(`(?<=[${CJK}])[ \\t\\u00a0]+(?=[${CJK}])`, 'g');
// 数字之间的分隔符常被 OCR 认成 `·`/`•`/`—`/`一`/`．`/`。`，需要还原成 `.` 或 `-`。
// 靠后面的位数判断：正好两位小数（`128·50`）当小数点，其余（`A2026·0042`）当连字符。
const RE_NUM_SEP = /(?<=\d)\s*[·•—–一．。]\s*(?=\d)/g;
const RE_NUM_SEP_DECIMAL = /(?<=\d)\s*[·•—–一．。]\s*(?=\d{2}(?!\d))/g;

/** 清洗 WinRT OCR 的原始文本：去掉汉字间空格、修正常见的标点误判。 */
export function cleanupOcrText(text) {
  let out = String(text ?? '').replace(/\r\n?/g, '\n');
  out = out.replace(RE_CJK_GAP, '');
  out = out.replace(RE_NUM_SEP_DECIMAL, '.');
  out = out.replace(RE_NUM_SEP, '-');
  // 保留换行，其余连续空白压成一个空格
  out = out
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function runPowerShell(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(POWERSHELL, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, error: `无法启动 PowerShell：${error?.message ?? error}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {}
      resolve({ ok: false, error: `OCR 超时（${timeoutMs}ms）` });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `OCR 进程启动失败：${error?.message ?? error}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

/** 识别一个图片文件。返回 { ok, text, lines, width, height, error? }。 */
export async function ocrImageFile(filePath, { lang = 'zh-Hans-CN', scale = 0, timeoutMs = 60000, scriptPath = DEFAULT_SCRIPT } = {}) {
  // PowerShell 的输出管道按控制台代码页编码，中文会变成乱码（Node 只会按 UTF-8 解）。
  // 所以让脚本把结果写进 UTF-8 JSON 文件，这里读文件；读不到再退回解析 stdout。
  const jsonDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qqbridge-ocr-json-'));
  const outFile = path.join(jsonDir, 'result.json');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-ImagePath', filePath, '-Lang', lang, '-OutFile', outFile];
  if (Number.isFinite(scale) && scale > 0 && scale !== 1) args.push('-Scale', String(scale));
  let res;
  let rawJson = '';
  try {
    res = await runPowerShell(args, { timeoutMs });
    try {
      rawJson = await fsp.readFile(outFile, 'utf8');
    } catch {}
  } finally {
    try {
      await fsp.rm(jsonDir, { recursive: true, force: true });
    } catch {}
  }
  if (res?.error) return { ok: false, error: res.error };
  const stdout = String(res?.stdout || '');
  const line = stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .find((s) => s.startsWith('OK ') || s.startsWith('ERR '));
  if (!line && !rawJson) {
    return { ok: false, error: `OCR 无输出${res?.stderr ? `：${String(res.stderr).trim().slice(0, 300)}` : ''}` };
  }
  if (line && line.startsWith('ERR ')) return { ok: false, error: line.slice(4).trim() || 'OCR 失败' };
  let parsed;
  try {
    parsed = JSON.parse(rawJson || line.slice(3));
  } catch (error) {
    return { ok: false, error: `OCR 结果不是合法 JSON：${error?.message ?? error}` };
  }
  const lines = (Array.isArray(parsed.lines) ? parsed.lines : []).map((s) => cleanupOcrText(s)).filter(Boolean);
  return {
    ok: true,
    lang: parsed.lang || lang,
    width: Number(parsed.width) || 0,
    height: Number(parsed.height) || 0,
    lines,
    text: lines.join('\n')
  };
}

/** 识别内存里的图片（QQ 图片都是 buffer/base64）。临时文件用完即删。 */
export async function ocrImageBuffer(buffer, { ext = 'png', tmpDir = os.tmpdir(), ...options } = {}) {
  const dir = await fsp.mkdtemp(path.join(tmpDir, 'qqbridge-ocr-'));
  const file = path.join(dir, `image.${ext}`);
  try {
    await fsp.writeFile(file, buffer);
    return await ocrImageFile(file, options);
  } finally {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch {}
  }
}

/** 从图片 URL 推断扩展名（临时文件后缀不影响解码，但更直观）。 */
export function extFromMime(mimeType, url) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('bmp')) return 'bmp';
  if (mime.includes('png')) return 'png';
  const m = /\.(jpe?g|png|webp|gif|bmp)(?:$|\?)/i.exec(String(url || ''));
  if (m) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  return 'png';
}

/** 本机有哪些 OCR 语言（排查「为什么识别不出来」时用）。 */
export async function listOcrLanguages() {
  const script = '$l=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]::AvailableRecognizerLanguages; ($l | ForEach-Object { $_.LanguageTag }) -join ","';
  const res = await runPowerShell(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeoutMs: 30000 });
  if (!res.ok || !res.stdout) return [];
  return res.stdout
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const ocrScriptPath = DEFAULT_SCRIPT;
export { cleanupOcrText as cleanOcrText };
