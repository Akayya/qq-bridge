// 梗百科自测：本地词库、提取规则、在线兜底、预查注入文案。
//   node scripts/test-memewiki.mjs
// 只跑本地部分：MEMEWIKI_OFFLINE=1 node scripts/test-memewiki.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { createMemeWiki, extractQuery, splitSections, htmlToText, entryText } from '../src/memewiki.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const wiki = createMemeWiki({
  dbPath: path.join(ROOT, 'data', 'memewiki', 'memes.db'),
  timeoutMs: 4000,
  log: (msg) => console.log('   [log]', msg)
});

let pass = 0;
let fail = 0;
async function okAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
  }
}
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
  }
}

console.log('词库本身');
ok('6660 条、有生成时间', () => {
  const s = wiki.stats();
  assert.equal(s.ok, true, s.error);
  assert.ok(s.count >= 6000, `count=${s.count}`);
  assert.ok(s.builtAt.length > 0);
  console.log(`       count=${s.count} builtAt=${s.builtAt}`);
});

console.log('精确匹配 / 包含匹配');
await okAsync('精确词条命中，含用法与出处', async () => {
  const r = await wiki.lookup('踢到铁板了');
  assert.equal(r.hit, true);
  assert.equal(r.data.source, 'local');
  assert.match(r.text, /【梗百科】踢到铁板了/);
  assert.match(r.text, /【怎么用 \/ 怎么接】/);
  assert.match(r.text, /【出处/);
  assert.ok(r.text.length > 60);
});
await okAsync('完整标题嵌在句子里也命中', async () => {
  const r = await wiki.lookup('这波真是踢到铁板了兄弟');
  assert.equal(r.hit, true);
  assert.equal(r.data.title, '踢到铁板了');
  assert.match(r.data.note, /没有同名条目/);
});
await okAsync('前缀式不算命中（strict 不模糊匹配）', async () => {
  const r = await wiki.lookup('你是什么', { strict: true });
  assert.equal(r.hit, false);
});

console.log('提取查询词');
ok('「XX 是什么梗」抽出 XX', () => {
  assert.equal(extractQuery('大水理论是什么梗？'), '大水理论');
  assert.equal(extractQuery('这到底什么梗'), null); // 代词 → 不查
});
ok('剥掉唤醒词和 @', () => {
  assert.equal(extractQuery('小鲸鱼 踢到铁板了是什么梗'), '踢到铁板了');
  assert.equal(extractQuery('@某某 寿来 啥意思'), '寿来');
});
ok('裸词命中，停用词不查', () => {
  assert.equal(extractQuery('踢到铁板了'), '踢到铁板了');
  assert.equal(extractQuery('在吗'), null);
  assert.equal(extractQuery('哈哈哈哈'), null);
  assert.equal(extractQuery('今天晚饭吃什么好呢'), null); // 太长/带标点
});

console.log('预查注入');
await okAsync('像问梗的消息 → 返回注入文案（先接梗提示在前）', async () => {
  const hint = await wiki.prefetchHint('小鲸鱼，踢到铁板了是什么梗');
  assert.match(hint, /\[梗词库内部资料/);
  assert.match(hint, /优先用这个词接梗/);
  assert.match(hint, /【梗百科】/);
  assert.ok(hint.indexOf('优先用这个词接梗') < hint.indexOf('【梗百科】'));
});
await okAsync('普通聊天 → 不注入', async () => {
  assert.equal(await wiki.prefetchHint('哈哈哈哈在吗'), '');
});
await okAsync('问一个不存在的词 → 不注入', async () => {
  assert.equal(await wiki.prefetchHint('qqqxxxzzz是什么梗'), '');
});
await okAsync('长句里夹着梗 + 「…啥意思来着」→ 也能抽出来', async () => {
  assert.equal(extractQuery('兄弟，今天这波真是踢到铁板了，这词啥意思来着'), '今天这波真是踢到铁板了');
  const hint = await wiki.prefetchHint('兄弟，今天这波真是踢到铁板了，这词啥意思来着');
  assert.match(hint, /踢到铁板了/);
});

console.log('解析工具函数');
ok('htmlToText：去标签、保小标题', () => {
  const text = htmlToText('<h2>用法</h2><p>用来吐槽<br>别人</p>');
  assert.match(text, /## 用法/);
  assert.match(text, /用来吐槽\n别人/);
});
ok('splitSections：分出用法/出处', () => {
  const s = splitSections('## 用法\n模仿他说\n## 来源\n某事件');
  assert.equal(s.usage, '模仿他说');
  assert.equal(s.origin, '某事件');
});
ok('entryText：模型版把「怎么用」放在「出处」前面', () => {
  const text = entryText({ title: 'T', tags: ['a'], usage: '用法U', origin: '出处O', other: '', note: '', extra: [], slug: 's' });
  assert.ok(text.indexOf('怎么用') < text.indexOf('出处'));
  assert.match(text, /cnmeme\.wiki\/词条\/s/);
});

if (process.env.MEMEWIKI_OFFLINE === '1') {
  console.log('（跳过在线兜底测试）');
} else {
  console.log('在线兜底（cnmeme.wiki）');
  await okAsync('本地没有的词 → 走在线接口拿到内容', async () => {
    const r = await wiki.lookup('大水理论');
    assert.equal(r.ok, true);
    if (r.hit) {
      assert.ok(r.text.length > 40);
      console.log(`       命中「${r.data.title}」来源=${r.data.source}`);
    } else {
      console.log('       在线也未收录（可接受）');
    }
  });
}

wiki.close();
console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
