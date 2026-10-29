#!/usr/bin/env node
/**
 * 补充：模型看不了图时，`/api/images/message`（MCP qq_get_message_images 的数据源）
 * 不再返回图像块（DSH 会因模型未声明 image 输入而拒），改成 OCR 文字；
 * 并在启动日志里说明当前模型走 OCR 通道。
 *
 * 幂等：已打过就跳过。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const file = path.join(ROOT, 'src', 'bridge.js');
const src = fs.readFileSync(file, 'utf8');
let out = src;
const applied = [];
const skipped = [];

function replaceOnce(label, from, to) {
  if (out.includes(to)) { skipped.push(label); return; }
  if (!out.includes(from)) throw new Error(`锚点没找到：${label}`);
  out = out.replace(from, to);
  applied.push(label);
}

// ── 启动日志：告诉运维「这个模型走 OCR 通道」 ────────────────────────────────
replaceOnce(
  '启动日志',
  `  for (const item of (Array.isArray(cfg.dsh?.visionUnsupported) ? cfg.dsh.visionUnsupported : [])) {
    noVisionModels.add(String(item));
  }
`,
  `  for (const item of (Array.isArray(cfg.dsh?.visionUnsupported) ? cfg.dsh.visionUnsupported : [])) {
    noVisionModels.add(String(item));
  }
  if (noVisionModels.size) {
    log(\`这些模型不支持图片输入，图片一律转成 OCR 文字：\${[...noVisionModels].join('、')}\`);
  }
`
);

// ── /api/images/message：不支持看图时返回 OCR 文字 ────────────────────────────
replaceOnce(
  'images/message OCR 降级',
  `          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, messageId, media, images });
          } catch (error) {
            log(\`图片查询失败 \${key} \${messageId}: \${error?.message ?? error}\`);
            sendJson({ ok: false, error: \`图片查询失败：\${error?.message ?? error}\` }, 500);
          }`,
  `          try {
            let images = await fetchMediaData(media);
            // 当前模型没声明图片输入时，图像块会让整条工具调用被 DSH 拒掉
            // （AcpContentError: model "..." does not declare image input）。
            // 这里直接把「看图」换成「读字」：文字仍能进模型，图片本身不投递。
            let visionNote = '';
            if (noVisionModels.has(currentChatModelKey()) && images.some((item) => item?.data)) {
              const converted = [];
              for (const item of images) {
                if (!item?.data) { converted.push(item); continue; }
                let text = item.text ? \`\${item.text} \` : '';
                try {
                  const ocr = await ocrImageBuffer(Buffer.from(String(item.data), 'base64'), {
                    ext: extFromMime(item.mimeType),
                    timeoutMs: 20000
                  });
                  const raw = ocr?.ok ? String(ocr.text ?? '').trim() : '';
                  text += raw ? \`（OCR：\${raw.slice(0, 1200)}）\` : '（这张图里没识别出文字）';
                } catch (error) {
                  text += \`（OCR 失败：\${error?.message ?? error}）\`;
                }
                converted.push({ ...item, data: undefined, text });
              }
              images = converted;
              visionNote = '当前模型不支持图片输入，已改为 OCR 文字';
            }
            sendJson({ ok: true, messageId, media, images, ...(visionNote ? { note: visionNote } : {}) });
          } catch (error) {
            log(\`图片查询失败 \${key} \${messageId}: \${error?.message ?? error}\`);
            sendJson({ ok: false, error: \`图片查询失败：\${error?.message ?? error}\` }, 500);
          }`
);

if (!applied.length) { console.log('已是目标状态，无需改动。'); process.exit(0); }
fs.writeFileSync(file + '.bak-vision2', src, 'utf8');
fs.writeFileSync(file, out, 'utf8');
console.log(`已应用 ${applied.length} 处：${applied.join(' / ')}`);
if (skipped.length) console.log(`跳过（已存在）：${skipped.join(' / ')}`);