// 翻译模块自测：纯逻辑 + 用假 fetch 跑完整流程（不依赖网络）。
//   node scripts/test-translate.mjs
// 想跑真接口：TRANSLATE_LIVE=1 node scripts/test-translate.mjs
import assert from 'node:assert/strict';
import {
  translateText,
  clearTranslateCache,
  splitChunks,
  guessLang,
  normalizeLang,
  decodeEntities
} from '../src/translate.js';

let pass = 0;
let fail = 0;
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

console.log('语言规范化');
ok('zh / cn / chinese → zh-CN', () => {
  for (const input of ['zh', 'cn', 'chinese', 'zh-CN', 'zh-hans']) assert.equal(normalizeLang(input), 'zh-CN');
});
ok('en / eng → en', () => {
  assert.equal(normalizeLang('EN'), 'en');
  assert.equal(normalizeLang('english'), 'en');
});
ok('ja / jp → ja，未知值原样保留', () => {
  assert.equal(normalizeLang('jp'), 'ja');
  assert.equal(normalizeLang('pt-BR'), 'pt-br');
});
ok('空值走 fallback', () => assert.equal(normalizeLang(''), 'zh-CN'));

console.log('语言猜测');
ok('中文 → zh-CN', () => assert.equal(guessLang('今天下雨记得带伞'), 'zh-CN'));
ok('日文（含假名）→ ja', () => assert.equal(guessLang('これはテストです'), 'ja'));
ok('英文 → en', () => assert.equal(guessLang('Please bring your passport'), 'en'));

console.log('分块');
ok('短文本不分块', () => assert.deepEqual(splitChunks('hello'), ['hello']));
ok('空文本返回空数组', () => assert.deepEqual(splitChunks('   '), []));
ok('长文本每块不超过上限', () => {
  const text = '这是一个很长的句子，用来测试分块逻辑。'.repeat(80);
  const chunks = splitChunks(text, 100);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 100, `块长 ${chunk.length}`);
  assert.equal(chunks.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
});
ok('中文句子标点处切开', () => {
  const chunks = splitChunks('第一句话说完了。第二句话也说完。第三句。', 12);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0].endsWith('。'));
});

console.log('HTML 实体还原');
ok('数字实体 / 命名实体 / &amp; 最后处理', () => {
  assert.equal(decodeEntities('&#39;hi&#39;'), "'hi'");
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
  assert.equal(decodeEntities('&amp;lt;'), '&lt;');
  assert.equal(decodeEntities('&quot;x&quot;'), '"x"');
});

console.log('translateText（假 fetch，不联网）');
okAsync('英文 → 中文：命中接口并返回译文', async () => {
  clearTranslateCache();
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({ responseData: { translatedText: '&quot;你好世界&quot;' } })
    };
  };
  const result = await translateText('hello world', { fetchImpl: fakeFetch, target: 'zh-CN' });
  assert.equal(result.ok, true);
  assert.equal(result.text, '"你好世界"');
  assert.equal(result.chunks, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('langpair=en%7Czh-CN') || calls[0].includes('langpair=en|zh-CN'));
});
okAsync('同语言不翻译（省额度，不请求接口）', async () => {
  clearTranslateCache();
  let called = 0;
  const result = await translateText('今天天气不错', { fetchImpl: async () => { called += 1; return {}; }, target: 'zh-CN' });
  assert.equal(result.ok, true);
  assert.equal(result.text, '今天天气不错');
  assert.equal(called, 0);
});
okAsync('缓存命中不重复请求', async () => {
  clearTranslateCache();
  let called = 0;
  const fakeFetch = async () => {
    called += 1;
    return { ok: true, status: 200, json: async () => ({ responseData: { translatedText: '缓存结果' } }) };
  };
  await translateText('cached case', { fetchImpl: fakeFetch });
  const second = await translateText('cached case', { fetchImpl: fakeFetch });
  assert.equal(called, 1);
  assert.equal(second.cached, true);
  assert.equal(second.text, '缓存结果');
});
okAsync('多块文本逐块翻译并拼接', async () => {
  clearTranslateCache();
  const long = 'Sentence one is here. '.repeat(60);
  let called = 0;
  const fakeFetch = async (url) => {
    called += 1;
    const q = decodeURIComponent(/q=([^&]+)/.exec(url)[1]);
    return { ok: true, status: 200, json: async () => ({ responseData: { translatedText: `译:${q.length}` } }) };
  };
  const result = await translateText(long, { fetchImpl: fakeFetch, maxChunks: 20 });
  assert.equal(result.ok, true);
  assert.ok(called > 1, `应该分多次请求，实际 ${called}`);
  assert.equal(result.text.split('\n').length, called);
});
okAsync('接口失败不抛异常，返回 ok:false 和原因', async () => {
  clearTranslateCache();
  const result = await translateText('failure case', {
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) })
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 429/);
  assert.match(result.error, /自己翻译/);
});
okAsync('返回空译文也算失败', async () => {
  clearTranslateCache();
  const result = await translateText('empty case', {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ responseData: {} }) })
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /空结果/);
});
okAsync('没有 fetch 时给出明确错误', async () => {
  clearTranslateCache();
  const result = await translateText('no fetch', { fetchImpl: null });
  assert.equal(result.ok, false);
  assert.match(result.error, /fetch/);
});
okAsync('空文本直接返回空', async () => {
  const result = await translateText('   ', { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  assert.equal(result.ok, true);
  assert.equal(result.text, '');
});

if (process.env.TRANSLATE_LIVE === '1') {
  console.log('真接口（需要联网）');
  await okAsync('live: hello world → 中文', async () => {
    clearTranslateCache();
    const result = await translateText('hello world', { target: 'zh-CN' });
    assert.equal(result.ok, true, result.error);
    assert.ok(result.text.length > 0);
    console.log(`      译文：${result.text}`);
  });
} else {
  console.log('（跳过一次真接口测试；要跑设 TRANSLATE_LIVE=1）');
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
