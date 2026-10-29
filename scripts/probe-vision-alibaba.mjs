#!/usr/bin/env node
/**
 * 探针：验证第三方通道（默认 alibaifan/deepseek-v4.1-flash）到底能不能看图。
 *
 * 做的事：
 *   1. 建一个临时 workspace + 会话（不挂 preset，避免把工具面扯进来）
 *   2. selectModel 到 config.json 里配置的 provider/model（不带 reasoningEffort —— 这条通道不支持）
 *   3. 发一条带 image content part 的 prompt（图由 --image 指定，默认现场生成）
 *   4. 轮询把回复读回来，打印「模型看到了什么」
 *
 * 用法：
 *   node scripts/probe-vision-alibaba.mjs                 # 用内置生成的红三角/蓝圆/数字 7 图
 *   node scripts/probe-vision-alibaba.mjs --image a.png
 *   node scripts/probe-vision-alibaba.mjs --text-only     # 不图片，只验链路与读取逻辑
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { NodeApiClient, unwrap, blocksToText } from '../src/dsh-client.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const baseUrl = config?.dsh?.baseUrl;
const provider = config?.dsh?.provider;
const model = config?.dsh?.model;

const args = process.argv.slice(2);
const textOnly = args.includes('--text-only');
const promptArg = (() => { const i = args.indexOf('--prompt'); return i >= 0 ? args[i + 1] : ''; })();
const imageArg = (() => {
  const i = args.indexOf('--image');
  return i >= 0 ? args[i + 1] : '';
})();

if (!baseUrl || !provider || !model) {
  console.error('config.json 缺少 dsh.baseUrl / dsh.provider / dsh.model');
  process.exit(1);
}

function base64Png(width, height, rgb) {
  // 极简 PNG 生成（纯色），避免依赖 canvas：只用 zlib。
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = rgb[0];
      raw[o + 1] = rgb[1];
      raw[o + 2] = rgb[2];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcTable = chunk.table ?? (chunk.table = (() => {
      const t = new Int32Array(256);
      for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
      }
      return t;
    })());
    let crc = -1;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ -1) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
  return png.toString('base64');
}

const client = new NodeApiClient(baseUrl, 30000, {});
let workspaceId = '';
let sessionId = '';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-probe-'));

try {
  const ws = unwrap(await client.workspace.create({ path: tmpDir }), 'workspace.create');
  workspaceId = ws.workspace.workspaceId;
  const created = unwrap(await client.sessions.create({ workspaceId }), 'session.create');
  sessionId = created.sessionId;
  console.log(`会话已建：${sessionId}`);

  try {
    unwrap(await client.sessions.selectModel({ sessionId, provider, model }), 'session.selectModel');
    console.log(`模型已选定：${provider}/${model}（未发 reasoningEffort）`);
  } catch (error) {
    // 选不上就按默认模型跑，至少能看出 DSH 是否接受图片 part
    console.log(`⚠️ selectModel 失败（${error?.message ?? error}），继续用会话默认模型`);
  }

  const content = [];
  if (textOnly) {
    content.push({ type: 'text', text: '只回复两个字：收到' });
  } else {
    if (imageArg) {
      const buf = fs.readFileSync(imageArg);
      content.push({ type: 'image', mediaType: 'image/png', data: buf.toString('base64') });
      console.log(`图片：${imageArg}（${buf.length} 字节）`);
    } else {
      content.push({ type: 'image', mediaType: 'image/png', data: base64Png(96, 96, [255, 210, 0]) });
      console.log('图片：内置纯黄色 96×96');
    }
    content.push({
      type: 'text',
      text: promptArg || '这张图是什么颜色？只回答颜色名，两个字以内。'
    });
  }

  const accepted = await client.sessions.prompt({ sessionId, mode: 'queue', content });
  console.log(`prompt 已提交：${JSON.stringify(accepted?.result?.ok ?? accepted)}`);

  const deadline = Date.now() + 120000;
  let answer = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    let loaded = null;
    for (const [method, payload] of [
      ['session/load', { sessionId }],
      ['session/projections', { sessionId }]
    ]) {
      try {
        loaded = unwrap(await client.callUnary(method, payload), method);
        if (loaded) break;
      } catch {
        loaded = null;
      }
    }
    if (!loaded) continue;
    const json = JSON.stringify(loaded);
    // 从任意形状里抓取 assistant 文本块（不同 DSH 版本字段名不完全一样）
    const texts = [];
    const walk = (node, depth = 0) => {
      if (!node || depth > 8) return;
      if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
      if (typeof node !== 'object') return;
      if (node.role === 'assistant' && Array.isArray(node.content)) {
        const t = blocksToText(node.content);
        if (t) texts.push(t);
      }
      for (const value of Object.values(node)) walk(value, depth + 1);
    };
    walk(loaded);
    // projections 里最省事的来源：turnOutline[].response（desktop 版实测有）
    const outline = [];
    const walkOutline = (node, depth = 0) => {
      if (!node || depth > 8) return;
      if (Array.isArray(node)) { for (const item of node) walkOutline(item, depth + 1); return; }
      if (typeof node !== 'object') return;
      if (Array.isArray(node.turnOutline)) {
        for (const t of node.turnOutline) if (t && typeof t.response === 'string' && t.response) outline.push(t.response);
      }
      for (const value of Object.values(node)) walkOutline(value, depth + 1);
    };
    walkOutline(loaded);
    const collected = [...texts, ...outline];
    if (collected.length) { answer = collected[collected.length - 1]; break; }
    if (/does not declare image input|AcpContentError|invalid_request_error|Free usage limit|自由额度|\b401\b|\b403\b/i.test(json)) {
      console.log('⚠️ 会话记录里出现可疑错误文本（可能是通道拒绝）：');
      console.log(json.slice(0, 900));
      break;
    }
  }

  if (answer) console.log(`\n✅ 模型回复：${answer.trim().slice(0, 400)}`);
  else console.log('\n❌ 120 秒内没读到 assistant 回复（看 DSH 日志或界面里这一轮的状态）');
} catch (error) {
  console.error(`\n❌ 失败：${error?.message ?? error}`);
  if (String(error?.message ?? '').includes('image')) {
    console.error('   → 看起来 DSH 仍然不肯把图片发出去（模型没声明 image 输入？改完记得重启 DSH）');
  }
} finally {
  if (sessionId) { try { await client.sessions.delete?.({ sessionId }); } catch {} }
  if (workspaceId) { try { await client.workspace.remove?.({ workspaceId }); } catch {} }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}