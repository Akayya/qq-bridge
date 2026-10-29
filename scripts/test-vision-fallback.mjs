#!/usr/bin/env node
/**
 * 「模型不支持看图」降级链路的回归测试。
 *
 * 覆盖三件事：
 *  1) 静态接线：bridge.js 里确实存在 noVisionModels / rememberNoVisionModel /
 *     looksLikeVisionRejection / resolveMediaList(..., { textOnly }) 这条链；
 *  2) 配置持久化：config.json 的 dsh.visionUnsupported 里有当前 provider/model；
 *  3) 真正的 OCR：用 WinRT OCR 读一张带中文的图片，确认文字能取出来
 *     （降级链路依赖它；取不出来就只是把「图片」换成「看不懂图」而已）。
 *
 * 用法：node scripts/test-vision-fallback.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ocrImageBuffer } from '../src/ocr.js';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  PASS ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('== 静态接线 ==');
const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
check('声明 noVisionModels 集合', /const noVisionModels = new Set\(\)/.test(bridge));
check('从 config.json 的 dsh.visionUnsupported 预填', /cfg\.dsh\?\.visionUnsupported/.test(bridge));
check('rememberNoVisionModel 会写回 config.json', /function rememberNoVisionModel/.test(bridge) && /visionUnsupported: \[\.\.\.list, modelKey\]/.test(bridge));
check('撞错判定包含 does not declare image input', /declare image input/.test(bridge));
check('resolveMediaList 支持 textOnly', /async function resolveMediaList\(mediaList, \{ textOnly = false \} = \{\}\)/.test(bridge));
check('textOnly 分支走 OCR 文字', /ocrImageBuffer\(img\.buffer/.test(bridge));
check('投递前先用已记录的 noVisionModels 预判', /const visionBlocked = noVisionModels\.has\(chatModelKey\)/.test(bridge));
check('撞错后重投一次（catch 分支）', /rememberNoVisionModel\(chatModelKey\)[\s\S]{0,200}buildContent\(true\)/.test(bridge));
check('qq_get_message_images 的数据源也转 OCR 文字', /noVisionModels\.has\(currentChatModelKey\(\)\) && images\.some/.test(bridge));
check('启动日志说明走 OCR 通道', /这些模型不支持图片输入，图片一律转成 OCR 文字/.test(bridge));

console.log('== 配置 ==');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const modelKey = `${cfg.dsh?.provider}/${cfg.dsh?.model}`;
const seeded = Array.isArray(cfg.dsh?.visionUnsupported) ? cfg.dsh.visionUnsupported : [];
// 黑名单留空 = 当前模型能看图（2026-10-29 实测 alibaifan 通道支持图片输入）
check(`dsh.visionUnsupported 是数组（留空表示当前模型能看图）`, Array.isArray(seeded), JSON.stringify(seeded));

console.log('== OCR（降级链路依赖） ==');
const tmp = path.join(os.tmpdir(), `vision-fallback-${Date.now()}.png`);
const sample = '小鲸鱼识图测试';
const ps = [
  'Add-Type -AssemblyName System.Drawing',
  '$bmp = New-Object System.Drawing.Bitmap 640,200',
  '$g = [System.Drawing.Graphics]::FromImage($bmp)',
  '$g.Clear([System.Drawing.Color]::White)',
  '$font = New-Object System.Drawing.Font("Microsoft YaHei", 48)',
  '$brush = [System.Drawing.Brushes]::Black',
  `$g.DrawString("${sample}", $font, $brush, 20, 60)`,
  '$bmp.Save("' + tmp.replace(/\\/g, '\\\\') + '", [System.Drawing.Imaging.ImageFormat]::Png)',
  '$g.Dispose(); $bmp.Dispose()'
].join('; ');
try {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'pipe', timeout: 30000 });
  const buffer = fs.readFileSync(tmp);
  const result = await ocrImageBuffer(buffer, { ext: 'png', timeoutMs: 30000 });
  const text = String(result?.text ?? '');
  check('OCR 成功返回', result?.ok === true, JSON.stringify(result).slice(0, 200));
  check('OCR 文字含「小鲸鱼」', text.includes('小鲸鱼'), JSON.stringify(text.slice(0, 120)));
  check('OCR 文字含「识图」', text.includes('识图'), JSON.stringify(text.slice(0, 120)));
} catch (error) {
  check('生成样图并 OCR', false, String(error?.message ?? error).slice(0, 200));
} finally {
  fs.rmSync(tmp, { force: true });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);