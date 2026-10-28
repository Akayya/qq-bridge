// 验证「不支持的模型把思考强度灰掉」这条链路：
//   1. GET /api/dsh/model 返回 effortSupported / effortSource
//   2. 当前通道不支持时，POST /api/dsh/effort 必须 409 且不写 config.json
//   3. 控制台页面里确实带着灰化逻辑（静态检查）
import fs from 'node:fs';

const tok = fs.readFileSync('D:/DSH_QQ_BOT/state/console-token', 'utf8').trim();
const base = 'http://127.0.0.1:3100';
const h = { 'content-type': 'application/json', 'x-console-token': tok };
let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  if (ok) { pass += 1; console.log('✔', label); } else { fail += 1; console.log('✘', label, extra); }
};

const model = await (await fetch(`${base}/api/dsh/model`, { headers: h })).json();
console.log('model =', JSON.stringify({ provider: model.provider, model: model.model, effortSupported: model.effortSupported, effortSource: model.effortSource, catalogSource: model.catalogSource }));
check(typeof model.effortSupported === 'boolean', 'GET /api/dsh/model 返回 effortSupported 布尔值');
check(['catalog', 'runtime', 'assumed'].includes(model.effortSource), 'effortSource 取值合法');

const before = JSON.parse(fs.readFileSync('D:/DSH_QQ_BOT/config.json', 'utf8')).dsh?.reasoningEffort;
const res = await fetch(`${base}/api/dsh/effort`, { method: 'POST', headers: h, body: JSON.stringify({ reasoningEffort: 'max' }) });
const body = await res.json();
if (model.effortSupported === false) {
  check(res.status === 409, '不支持时 POST /api/dsh/effort 返回 409', `status=${res.status}`);
  check(body.ok === false && /不支持思考强度/.test(String(body.error)), '错误文案点明原因', JSON.stringify(body));
  const after = JSON.parse(fs.readFileSync('D:/DSH_QQ_BOT/config.json', 'utf8')).dsh?.reasoningEffort;
  check(after === before, '被拒时没有改 config.json 的思考强度', `${before} -> ${after}`);
} else {
  check(true, '当前模型支持思考强度，POST 走正常分支（跳过 409 断言）');
  check(/reasoningEffort/.test(JSON.stringify(body)), 'POST 返回 reasoningEffort 字段', JSON.stringify(body));
}

const html = fs.readFileSync('D:/DSH_QQ_BOT/public/console.html', 'utf8');
check(/r\.effortSupported !== false/.test(html), '控制台读取 effortSupported');
check(/select\.disabled = !supported/.test(html), '控制台据支持与否禁用下拉');
check(/saveBtn\.disabled = !supported/.test(html), '控制台据支持与否禁用保存按钮');
check(/该通道不接受 reasoningEffort/.test(html), '控制台展示「通道不接受」的原因文案');

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);