// 把当前 provider/model 标成「不支持思考强度」并验证控制台接口的灰化逻辑。
// 用法：node scripts/seed-effort-unsupported.mjs [provider/model]
import fs from 'node:fs';

const key = process.argv[2] || 'alibaifan/deepseek-v4.1-flash';
const file = 'D:/DSH_QQ_BOT/config.json';
const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
doc.dsh = doc.dsh ?? {};
const list = Array.isArray(doc.dsh.effortUnsupported) ? doc.dsh.effortUnsupported.map(String) : [];
if (!list.includes(key)) list.push(key);
doc.dsh.effortUnsupported = list;
fs.copyFileSync(file, `${file}.bak-effortseed`);
fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
console.log('已写入 dsh.effortUnsupported =', JSON.stringify(list));