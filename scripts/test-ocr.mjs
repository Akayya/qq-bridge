/**
 * OCR 模块自测：`node scripts/test-ocr.mjs`
 *
 * 覆盖两层：
 *   1. 纯函数（不依赖系统）：Windows OCR 那种「每个汉字都插一个空格」的清洗规则、数字标点修正。
 *   2. 真机识别（需要 Windows OCR 引擎）：用一张现场生成的 PNG 图，断言能认出关键字。
 *      生成图依赖 System.Drawing（Windows 自带）；跑不了就跳过，不算失败。
 *
 * 想指定自己的测试图：`OCR_TEST_IMAGE=D:\shots\a.png node scripts/test-ocr.mjs`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { cleanupOcrText, ocrImageFile, listOcrLanguages } from '../src/ocr.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` → ${detail}` : ''}`);
  }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

console.log('\n[1] 文本清洗（WinRT OCR 会把汉字之间插空格）');
eq('去掉汉字间空格', cleanupOcrText('识 别 测 试'), '识别测试');
eq('保留英文单词间空格', cleanupOcrText('Engine: Windows Media Ocr'), 'Engine: Windows Media Ocr');
eq('数字间全角点修正', cleanupOcrText('金额 128．50 元'), '金额 128.50 元');
eq('数字间间隔号修正', cleanupOcrText('订单 A2026 · 0042'), '订单 A2026-0042');
eq('中文标点前后空格去掉', cleanupOcrText('今 天 下 雨 ， 记 得 带 伞 。'), '今天下雨，记得带伞。');
eq('多行保留换行', cleanupOcrText('第 一 行\n第 二 行'), '第一行\n第二行');
eq('连续空行压缩', cleanupOcrText('a\n\n\n\nb'), 'a\n\nb');
eq('空输入', cleanupOcrText(''), '');
eq('null 输入', cleanupOcrText(null), '');

console.log('\n[2] 系统 OCR 能力');
const langs = await listOcrLanguages();
console.log(`  可用语言：${langs.length ? langs.join(', ') : '（无）'}`);
check('至少有一个 OCR 语言', langs.length > 0);

function makeImage(outPath) {
  const ps = [
    'Add-Type -AssemblyName System.Drawing;',
    `$bmp = New-Object System.Drawing.Bitmap 900, 240;`,
    '$g = [System.Drawing.Graphics]::FromImage($bmp);',
    '$g.Clear([System.Drawing.Color]::White);',
    `$font = New-Object System.Drawing.Font('Microsoft YaHei', 30);`,
    `$g.DrawString('识别测试 订单号 2026 金额 128.50', $font, [System.Drawing.Brushes]::Black, 20, 60);`,
    '$g.Dispose();',
    `$bmp.Save('${outPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png);`,
    '$bmp.Dispose();',
    `Write-Output 'ok'`,
  ].join(' ');
  return new Promise((resolve) => {
    execFile(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true, timeout: 60000 },
      (error) => resolve(!error && fs.existsSync(outPath))
    );
  });
}

const ownImage = process.env.OCR_TEST_IMAGE || '';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbridge-ocr-test-'));
const testImage = ownImage || path.join(tmpDir, 'sample.png');
let haveImage = !!ownImage;
if (!haveImage) haveImage = await makeImage(testImage);

console.log('\n[3] 真机识别');
if (!haveImage) {
  console.log('  - 跳过（本机生成测试图失败，也没有设置 OCR_TEST_IMAGE）');
} else {
  const started = Date.now();
  const result = await ocrImageFile(testImage, { scale: 0 });
  const took = Date.now() - started;
  console.log(`  用时 ${took}ms，尺寸 ${result.width}x${result.height}`);
  console.log(`  识别结果：${JSON.stringify(result.text)}`);
  check('识别成功', result.ok === true, result.error || '');
  if (result.ok) {
    check('识别结果非空', result.lines.length > 0);
    check('认出「金额」', result.text.includes('金额'), result.text);
    check('认出 128.50 或 128', /128[.\-]?50|128/.test(result.text), result.text);
    check('汉字之间没有空格', !/[一-龥]\s+[一-龥]/.test(result.text), result.text);
    check('耗时 < 30s', took < 30000, `${took}ms`);
  }
}

try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
