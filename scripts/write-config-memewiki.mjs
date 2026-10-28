import fs from 'node:fs';

const cfgPath = 'config.json';
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.memewiki = {
  enabled: true,
  dbPath: '',
  apiBase: '',
  timeoutMs: 2500,
  autoPrefetch: true,
  ...(cfg.memewiki ?? {})
};
cfg.socialV2 ??= {};
cfg.socialV2.tools ??= {};
cfg.socialV2.tools.meme = cfg.socialV2.tools.meme !== false;
fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

const pkgPath = 'package.json';
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.scripts ??= {};
pkg.scripts['test:memewiki'] = 'node scripts/test-memewiki.mjs';
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const examplePath = 'config.example.json';
if (fs.existsSync(examplePath)) {
  const ex = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
  ex.memewiki = { enabled: true, dbPath: '', apiBase: '', timeoutMs: 2500, autoPrefetch: true };
  ex.socialV2 ??= {};
  ex.socialV2.tools ??= {};
  ex.socialV2.tools.meme = true;
  fs.writeFileSync(examplePath, `${JSON.stringify(ex, null, 2)}\n`);
}

console.log('config.json / package.json / config.example.json 已更新');
console.log('memewiki =', JSON.stringify(cfg.memewiki));
console.log('socialV2.tools.meme =', cfg.socialV2.tools.meme);
