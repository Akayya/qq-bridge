#!/usr/bin/env node
/**
 * 把当前桥接使用的模型登记进 config.json 的 `dsh.visionUnsupported`：
 * 列在这里的模型会被桥接当成「不支持图片输入」，图片一律走 OCR 文字，
 * 避免 DSH 抛 `AcpContentError: model "..." does not declare image input`。
 *
 * 用法：
 *   node scripts/seed-vision-unsupported.mjs                 # 登记 config.json 当前的 provider/model
 *   node scripts/seed-vision-unsupported.mjs alibaifan/deepseek-v4.1-flash
 *   node scripts/seed-vision-unsupported.mjs --remove alibaifan/deepseek-v4.1-flash
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONFIG = path.join(ROOT, 'config.json');

const args = process.argv.slice(2);
const remove = args[0] === '--remove';
const explicit = (remove ? args[1] : args[0]) || '';

const raw = fs.readFileSync(CONFIG, 'utf8');
const config = JSON.parse(raw);
const modelKey = explicit || `${config?.dsh?.provider ?? ''}/${config?.dsh?.model ?? ''}`;
if (!modelKey || modelKey === '/') {
  console.error('取不到模型标识：请显式传 <provider>/<model>');
  process.exit(1);
}

config.dsh = config.dsh && typeof config.dsh === 'object' ? config.dsh : {};
const list = new Set(Array.isArray(config.dsh.visionUnsupported) ? config.dsh.visionUnsupported.map(String) : []);
if (remove) list.delete(modelKey);
else list.add(modelKey);
config.dsh.visionUnsupported = [...list];

if (JSON.stringify(config) === JSON.stringify(JSON.parse(raw))) {
  console.log(`无需改动：dsh.visionUnsupported = ${JSON.stringify(config.dsh.visionUnsupported)}`);
  process.exit(0);
}
fs.writeFileSync(CONFIG + '.bak-visionseed', raw, 'utf8');
fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n', 'utf8');
console.log(`${remove ? '已移除' : '已登记'}：${modelKey}`);
console.log(`dsh.visionUnsupported = ${JSON.stringify(config.dsh.visionUnsupported)}`);
console.log('提示：桥接重启后生效（node launch-detached.mjs）。');