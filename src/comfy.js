// ComfyUI 客户端 + 进程管理（静默拉起）。
//
// 目标：让 bot 在自己机器上出图，而不是让用户先去开绘世启动器。
//   - status()         探测 8188 是否活着（1.5 秒超时，不阻塞）
//   - ensureRunning()  没开就 spawn python main.py（detached + windowsHide，不弹窗）
//   - render()         套工作流模板 → /prompt → 轮询 /history → /view 取图
//
// 只依赖 node 内置能力（fetch / child_process / fs），不引入任何新依赖。
// ComfyUI 的启动参数说明见 comfy/cli_args.py；这里只用 --port/--listen/
// --disable-auto-launch/--dont-print-server 四个，都是长期存在的参数。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_WORKFLOW = 'anima-turbo';

// 这些字段从模板里换出来是字符串，必须还原成数字（ComfyUI 的节点校验很严格）。
const NUMERIC_KEYS = new Set([
  'seed', 'noise_seed', 'steps', 'cfg', 'width', 'height', 'denoise', 'batch_size',
  'length', 'fps', 'frames', 'strength', 'guidance', 'shift', 'batch_size'
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 把值安全地塞进 JSON 字符串字面量里（模板里的 "{{prompt}}"）。 */
function jsonEscape(value) {
  return JSON.stringify(String(value ?? '')).slice(1, -1);
}

function numOr(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function createComfy(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const baseUrl = String(options.baseUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '');
  const installDir = String(options.installDir || '');
  const python = String(options.python || '');
  const port = numOr(options.port, 8188, 1, 65535);
  const listen = String(options.listen || '127.0.0.1');
  const workflowDir = String(options.workflowDir || '');
  const workDir = String(options.workDir || '');
  const autoStart = options.autoStart !== false;
  const startupTimeoutMs = numOr(options.startupTimeoutMs, 240000, 10000, 900000);
  const jobTimeoutMs = numOr(options.jobTimeoutMs, 900000, 10000, 3600000);
  const defaultWorkflow = String(options.workflow || DEFAULT_WORKFLOW);

  let startPromise = null;
  let lastProbe = { at: 0, value: null };
  const templateCache = new Map();

  /** 探测服务是否活着；失败不抛，返回 {running:false, reason}。 */
  async function probe({ timeoutMs = 1500 } = {}) {
    try {
      const res = await fetch(`${baseUrl}/system_stats`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { running: false, reason: `HTTP ${res.status}` };
      const body = await res.json().catch(() => null);
      const devices = Array.isArray(body?.devices) ? body.devices : [];
      return {
        running: true,
        baseUrl,
        port,
        devices: devices.map((d) => ({
          name: String(d?.name ?? ''),
          type: String(d?.type ?? ''),
          vramTotal: Number(d?.vram_total ?? 0),
          vramFree: Number(d?.vram_free ?? 0)
        })),
        version: body?.system?.comfyui_version ?? null,
        python: body?.system?.python_version ?? null
      };
    } catch (error) {
      return { running: false, reason: error?.name === 'TimeoutError' ? '探测超时' : String(error?.message ?? error) };
    }
  }

  async function status({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && lastProbe.value && now - lastProbe.at < 5000) return lastProbe.value;
    const value = await probe();
    lastProbe = { at: Date.now(), value };
    return value;
  }

  /** 拉起 ComfyUI（已在跑就直接返回）；并发调用会复用同一个 Promise。 */
  async function ensureRunning() {
    const current = await status({ fresh: true });
    if (current.running) return { started: false, status: current };
    if (!autoStart) throw new Error('ComfyUI 没在运行，且 comfy.autoStart 为 false（不自动拉起）');
    if (!python || !installDir) throw new Error('ComfyUI 未配置完整（comfy.python / comfy.installDir 为空）');
    if (!fs.existsSync(python)) throw new Error(`找不到 ComfyUI 的 python：${python}`);
    if (!fs.existsSync(path.join(installDir, 'main.py'))) throw new Error(`找不到 ComfyUI 的 main.py：${installDir}`);
    if (startPromise) return startPromise;

    startPromise = (async () => {
      const logDir = path.dirname(String(options.logPath || path.join(workDir, 'comfy.log')));
      try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* 目录已存在即可 */ }
      const outPath = String(options.logPath || path.join(workDir, 'comfy.log'));
      const out = fs.openSync(outPath, 'a');
      const args = ['main.py', '--port', String(port), '--listen', listen, '--disable-auto-launch', '--dont-print-server'];
      log(`ComfyUI 未运行，静默拉起：${python} ${args.join(' ')}（日志 ${outPath}）`);
      let child;
      try {
        child = spawn(python, args, {
          cwd: installDir,
          detached: true,
          windowsHide: true,
          stdio: ['ignore', out, out],
          env: { ...process.env, PYTHONUNBUFFERED: '1' }
        });
      } finally {
        try { fs.closeSync(out); } catch { /* 交给子进程句柄 */ }
      }
      child.on('error', (error) => log(`⚠️ ComfyUI 启动失败：${error.message}`));
      child.unref();
      const startedAt = Date.now();
      let lastNote = 0;
      while (Date.now() - startedAt < startupTimeoutMs) {
        await sleep(2000);
        const st = await probe({ timeoutMs: 2000 });
        if (st.running) {
          log(`ComfyUI 已就绪（${Math.round((Date.now() - startedAt) / 1000)}s，pid ${child.pid ?? '?'}）`);
          lastProbe = { at: Date.now(), value: st };
          return { started: true, pid: child.pid ?? null, status: st, elapsedMs: Date.now() - startedAt };
        }
        if (Date.now() - lastNote > 20000) {
          lastNote = Date.now();
          log(`ComfyUI 启动中…（${Math.round((Date.now() - startedAt) / 1000)}s，首次启动可能要加载 torch）`);
        }
      }
      throw new Error(`ComfyUI 启动超时（${Math.round(startupTimeoutMs / 1000)}s），看日志：${outPath}`);
    })();

    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  function workflowNames() {
    if (!workflowDir || !fs.existsSync(workflowDir)) return [];
    return fs.readdirSync(workflowDir)
      .filter((name) => name.toLowerCase().endsWith('.json'))
      .map((name) => name.replace(/\.json$/i, ''))
      .sort();
  }

  function loadTemplate(name) {
    const file = path.join(workflowDir, `${String(name || defaultWorkflow)}.json`);
    if (!fs.existsSync(file)) {
      throw new Error(`工作流模板不存在：${file}（可用：${workflowNames().join(', ') || '无'}）`);
    }
    const stat = fs.statSync(file);
    const cached = templateCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    const entry = { mtimeMs: stat.mtimeMs, size: stat.size, raw, parsed, file };
    templateCache.set(file, entry);
    return entry;
  }

  /** 把模板里的 {{占位符}} 换成实际值（先转义再替换，避免提示词里的引号破坏 JSON）。 */
  function buildPrompt(name, params = {}) {
    const template = loadTemplate(name);
    let text = template.raw;
    const mapping = {
      prompt: params.prompt ?? '',
      negative: params.negative ?? template.parsed?.__defaults?.negative ?? '',
      seed: String(numOr(params.seed, Math.floor(Math.random() * 4294967295), 0, 4294967295)),
      width: String(numOr(params.width, 1024, 64, 4096)),
      height: String(numOr(params.height, 1024, 64, 4096)),
      steps: String(numOr(params.steps, template.parsed?.__defaults?.steps ?? 10, 1, 100)),
      cfg: String(Number.isFinite(Number(params.cfg)) ? Number(params.cfg) : (template.parsed?.__defaults?.cfg ?? 1)),
      filename: String(params.filename ?? 'anima')
    };
    for (const [key, value] of Object.entries(mapping)) {
      text = text.split(`{{${key}}}`).join(jsonEscape(value));
    }
    const prompt = JSON.parse(text);
    // 模板里的数字占位符写成 "{{seed}}" 这样（保证模板本身是合法 JSON），
    // 换完之后再按字段名把数字串还原成数字，否则 ComfyUI 会把它当字符串拒绝。
    for (const node of Object.values(prompt)) {
      if (!node || typeof node !== 'object' || !node.inputs) continue;
      for (const [key, value] of Object.entries(node.inputs)) {
        if (!NUMERIC_KEYS.has(key) || typeof value !== 'string') continue;
        const n = Number(value);
        if (Number.isFinite(n)) node.inputs[key] = n;
      }
    }
    delete prompt.__defaults;
    return { prompt, seed: Number(mapping.seed), file: template.file };
  }

  async function submit(prompt) {
    const clientId = `qqbridge-${Date.now().toString(36)}`;
    const res = await fetch(`${baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: clientId }),
      signal: AbortSignal.timeout(30000)
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.prompt_id) {
      const detail = body?.error?.message || body?.node_errors ? JSON.stringify(body?.node_errors ?? body?.error ?? body).slice(0, 400) : `HTTP ${res.status}`;
      throw new Error(`提交工作流失败：${detail}`);
    }
    return { promptId: String(body.prompt_id), clientId, number: body.number ?? null };
  }

  async function waitForResult(promptId, { timeoutMs = jobTimeoutMs, intervalMs = 1500 } = {}) {
    const startedAt = Date.now();
    let lastNote = 0;
    while (Date.now() - startedAt < timeoutMs) {
      const res = await fetch(`${baseUrl}/history/${encodeURIComponent(promptId)}`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        const entry = body?.[promptId];
        if (entry) {
          const statusStr = String(entry?.status?.status_str ?? '');
          if (statusStr === 'error') {
            const messages = Array.isArray(entry?.status?.messages) ? entry.status.messages : [];
            throw new Error(`ComfyUI 执行出错：${JSON.stringify(messages).slice(0, 500)}`);
          }
          const images = [];
          for (const output of Object.values(entry.outputs ?? {})) {
            for (const image of output?.images ?? []) {
              if (image?.filename) images.push({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' });
            }
          }
          if (images.length) return { images, elapsedMs: Date.now() - startedAt };
          if (statusStr === 'success') throw new Error('工作流成功但没有产出图片（检查 SaveImage 节点）');
        }
      }
      if (Date.now() - lastNote > 15000) {
        lastNote = Date.now();
        log(`ComfyUI 出图中…（${Math.round((Date.now() - startedAt) / 1000)}s）`);
      }
      await sleep(intervalMs);
    }
    throw new Error(`ComfyUI 出图超时（${Math.round(timeoutMs / 1000)}s）`);
  }

  async function fetchImage({ filename, subfolder = '', type = 'output' }) {
    const query = new URLSearchParams({ filename, subfolder, type });
    const res = await fetch(`${baseUrl}/view?${query}`, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`取图失败：HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) throw new Error('取图失败：空文件');
    return buffer;
  }

  async function interrupt() {
    const res = await fetch(`${baseUrl}/interrupt`, { method: 'POST', signal: AbortSignal.timeout(10000) });
    return { ok: res.ok, status: res.status };
  }

  /** 出图并落盘到 workDir，返回文件路径与 buffer（调用方负责发出去）。 */
  async function render(params = {}) {
    const workflow = params.workflow || defaultWorkflow;
    const built = buildPrompt(workflow, params);
    const startedAt = Date.now();
    const submitted = await submit(built.prompt);
    const result = await waitForResult(submitted.promptId, { timeoutMs: numOr(params.timeoutMs, jobTimeoutMs, 10000, 3600000) });
    const first = result.images[0];
    const buffer = await fetchImage(first);
    fs.mkdirSync(workDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outFile = path.join(workDir, `comfy-${stamp}-${built.seed}.png`);
    fs.writeFileSync(outFile, buffer);
    return {
      file: outFile,
      buffer,
      bytes: buffer.length,
      seed: built.seed,
      workflow,
      promptId: submitted.promptId,
      elapsedMs: Date.now() - startedAt,
      images: result.images
    };
  }

  return {
    baseUrl,
    port,
    workflowDir,
    workDir,
    workflowNames,
    loadTemplate,
    buildPrompt,
    probe,
    status,
    ensureRunning,
    submit,
    waitForResult,
    fetchImage,
    interrupt,
    render
  };
}

export { DEFAULT_WORKFLOW };