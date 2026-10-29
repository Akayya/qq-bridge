#!/usr/bin/env node
/**
 * 把 ffmpeg 装到 tools\ffmpeg\bin\ffmpeg.exe，并写进 config.json 的 socialV2.voice.ffmpegPath。
 *
 * 为什么从 npm 包里取：ffmpeg 官网（gyan.dev）在本机约 0.01 MB/s，GitHub release 约 0.65 MB/s，
 * 而 registry.npmjs.org 稳定几十 KB/s 以上；@ffmpeg-installer/win32-x64 就是官方静态构建打的包。
 *
 * 用法：
 *   node scripts/setup-ffmpeg.mjs            # 已存在则跳过（打印当前版本）
 *   node scripts/setup-ffmpeg.mjs --force    # 强制重装
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = '@ffmpeg-installer/win32-x64';
const TARGET_DIR = path.join(ROOT, 'tools', 'ffmpeg');
const TARGET_EXE = path.join(TARGET_DIR, 'bin', 'ffmpeg.exe');
const CONFIG = path.join(ROOT, 'config.json');

const force = process.argv.includes('--force');

function log(msg) {
  console.log(`[ffmpeg] ${msg}`);
}

function run(exe, args) {
  const r = spawnSync(exe, args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function version() {
  const r = run(TARGET_EXE, ['-hide_banner', '-version']);
  return r.ok ? r.out.split(/\r?\n/)[0] : '';
}

function updateConfig() {
  if (!fs.existsSync(CONFIG)) {
    log('没有 config.json，跳过写配置');
    return;
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  cfg.socialV2 ??= {};
  cfg.socialV2.voice ??= {};
  const wanted = TARGET_EXE.replaceAll('\\', '/');
  if (cfg.socialV2.voice.ffmpegPath === wanted) {
    log(`config.json 已指向 ${wanted}`);
    return;
  }
  fs.copyFileSync(CONFIG, `${CONFIG}.bak-ffmpeg`);
  cfg.socialV2.voice.ffmpegPath = wanted;
  fs.writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  log(`config.json → socialV2.voice.ffmpegPath = ${wanted}（备份 .bak-ffmpeg）`);
}

async function download() {
  const metaRes = await fetch(`https://registry.npmjs.org/${PKG}`);
  if (!metaRes.ok) throw new Error(`取包信息失败 HTTP ${metaRes.status}`);
  const meta = await metaRes.json();
  const ver = meta['dist-tags'].latest;
  const url = meta.versions[ver].dist.tarball;
  log(`下载 ${PKG}@${ver}`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const chunks = [];
  let got = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    got += chunk.length;
    if (total && got / total >= 0.25 * Math.ceil((got - chunk.length) / (total * 0.25) + 1)) {
      log(`已下载 ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
    }
  }
  const buf = Buffer.concat(chunks);
  log(`下载完成 ${(buf.length / 1048576).toFixed(1)} MB`);

  const tmpTgz = path.join(ROOT, 'tools-ffmpeg-download.tgz');
  fs.writeFileSync(tmpTgz, buf);
  fs.mkdirSync(TARGET_DIR, { recursive: true });
  const untar = run('tar', ['-xzf', tmpTgz, '-C', TARGET_DIR]);
  fs.rmSync(tmpTgz, { force: true });
  if (!untar.ok) throw new Error(`解压失败：${untar.out}`);

  const pkgExe = path.join(TARGET_DIR, 'package', 'ffmpeg.exe');
  if (!fs.existsSync(pkgExe)) throw new Error('压缩包里没有 ffmpeg.exe');
  fs.mkdirSync(path.join(TARGET_DIR, 'bin'), { recursive: true });
  fs.renameSync(pkgExe, TARGET_EXE);
  fs.rmSync(path.join(TARGET_DIR, 'package'), { recursive: true, force: true });
  fs.writeFileSync(
    path.join(TARGET_DIR, 'README.txt'),
    [
      'ffmpeg (portable)',
      `版本：${version() || '未知'}`,
      `来源：npm 包 ${PKG}@${ver} 内附的可执行文件`,
      '用途：桥接图片压缩 / GIF 抽帧拼接（config.json 的 socialV2.voice.ffmpegPath 指向本文件）',
      '许可：GPL（原样分发，未修改）',
      ''
    ].join('\n'),
    'utf8'
  );
}

if (fs.existsSync(TARGET_EXE) && !force) {
  log(`已存在：${TARGET_EXE}`);
  log(version() || '(无法执行)');
  updateConfig();
  process.exit(0);
}

try {
  await download();
  const v = version();
  if (!v) throw new Error('安装后无法执行，请检查文件是否被杀毒软件隔离');
  log(`已安装 ${TARGET_EXE}`);
  log(v);
  updateConfig();
  log('重启桥接后生效：node launch-detached.mjs');
} catch (error) {
  log(`失败：${error.message}`);
  process.exitCode = 1;
}