/**
 * preset patch 同步检查：改了 dsh/agent-presets/<name>/agent.cordis.yml 却忘了
 * 重新生成 plugins/qq-agent-presets/presets/<name>.patch.yml 时，DSH 加载的仍是旧正文。
 *
 * 这个测试就是防这个：① 源 YAML 必须能被解析（缩进写错会直接抛）；② 生成结果必须与
 * 磁盘上的 patch 逐字一致（否则说明忘了跑 build-agent-preset-patches）。
 *
 * 用法：node scripts/test-preset-patch-sync.mjs
 */
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { PRESETS, patchFileFor, renderPatch, REPO_ROOT } from "./build-agent-preset-patches.mjs";

let pass = 0;
let fail = 0;
function ok(cond, label, extra = "") {
  if (cond) {
    pass++;
    console.log(`✅ ${label}`);
  } else {
    fail++;
    console.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

for (const name of PRESETS) {
  const dir = path.join(REPO_ROOT, "dsh", "agent-presets", name);
  const sourceFile = path.join(dir, "agent.cordis.yml");

  // ① 源文件存在且是合法 YAML
  const raw = fs.existsSync(sourceFile) ? fs.readFileSync(sourceFile, "utf8") : "";
  ok(Boolean(raw), `${name}: agent.cordis.yml 存在`, sourceFile);
  if (!raw) continue;

  let parsed = null;
  let parseError = "";
  try {
    parsed = yaml.load(raw);
  } catch (error) {
    parseError = error?.message ?? String(error);
  }
  ok(!parseError, `${name}: agent.cordis.yml 是合法 YAML`, parseError);
  ok(Array.isArray(parsed) && parsed.length > 0, `${name}: agent.cordis.yml 顶层是行数组`);
  if (parseError || !Array.isArray(parsed)) continue;

  // ② 生成结果与磁盘上的 patch 一致
  let rendered = "";
  let renderError = "";
  try {
    rendered = renderPatch(name);
  } catch (error) {
    renderError = error?.message ?? String(error);
  }
  ok(!renderError, `${name}: 可以渲染 patch`, renderError);
  if (renderError) continue;

  const patchFile = patchFileFor(name);
  const onDisk = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, "utf8") : null;
  ok(onDisk !== null, `${name}: patch 文件存在`, path.relative(REPO_ROOT, patchFile));
  ok(
    onDisk === rendered,
    `${name}: patch 与源同步（不一致就运行 node scripts/build-agent-preset-patches.mjs）`,
    onDisk === rendered ? "" : "磁盘上的 patch 过期或手工改过",
  );
}

console.log(`\n${fail === 0 ? "全部通过" : "失败"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);