// 给 config.json 的 socialV2.ocr 补 translate 默认值，给 package.json 补 test:translate。
import fs from 'node:fs';

const cfgPath = 'D:/DSH_QQ_BOT/config.json';
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.socialV2 ??= {};
cfg.socialV2.ocr = { enabled: true, lang: 'zh-Hans-CN', maxImages: 3, scale: 0, timeoutMs: 45000, ...(cfg.socialV2.ocr ?? {}), translate: 'zh-CN' };
cfg.socialV2.tools = { ocr: true, recall: true, like: true, ...(cfg.socialV2.tools ?? {}) };
fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
console.log('config.json 已更新：', JSON.stringify(cfg.socialV2.ocr));

const pkgPath = 'D:/DSH_QQ_BOT/package.json';
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.scripts ??= {};
pkg.scripts['test:translate'] = 'node scripts/test-translate.mjs';
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log('package.json scripts:', Object.keys(pkg.scripts).join(', '));
