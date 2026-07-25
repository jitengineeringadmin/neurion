// Assemble a self-contained runtime stack for the packaged desktop app.
//
// Produces apps/desktop/staging/ with:
//   api/       NestJS dist + prisma (schema, migrations, compiled seed.js) + node_modules
//   web/       Next .next build + next.config + node_modules (next/react/...)
//   _desktop/  embedded-postgres (+ platform PG binary, pg) for main.js
//   .env       runtime config (DATABASE_URL is overridden by main.js at launch)
//
// node_modules are produced with `npm install --omit=dev` per staged package.
// Unlike `pnpm deploy`, npm emits a real, symlink-free tree — it survives being
// copied into the installer and avoids pnpm's absolute-symlink store entirely.

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, mkdirSync, cpSync, copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESK = path.resolve(__dirname, '..'); // apps/desktop
const ROOT = path.resolve(DESK, '..', '..'); // repo root
const STAGE = path.join(DESK, 'staging'); // electron-builder extraResources source
const API_SRC = path.join(ROOT, 'apps', 'api');
const WEB_SRC = path.join(ROOT, 'apps', 'web');

const isWin = process.platform === 'win32';
const pnpm = isWin ? 'pnpm.cmd' : 'pnpm';
const npm = isWin ? 'npm.cmd' : 'npm';

function step(msg) {
  console.log(`\n=== ${msg} ===`);
}
function sh(cmd, args, opts = {}) {
  console.log('>', cmd, args.join(' '));
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: isWin, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} -> exit ${r.status}`);
}
const copy = (from, to) => cpSync(from, to, { recursive: true });
const npmInstall = (cwd) => sh(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd });

// 0) clean
step('clean staging');
if (existsSync(STAGE)) rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

// 1) build api + web from source (uses the workspace toolchain)
step('build api (nest)');
sh(pnpm, ['--filter', '@neurion/api', 'build']);
step('build web (next)');
sh(pnpm, ['--filter', '@neurion/web', 'build'], {
  env: { ...process.env, NEXT_PUBLIC_API_URL: 'http://localhost:8091' },
});

// 2) stage api: dist + prisma + compiled seed + prod node_modules + generated client
step('stage api');
const apiStage = path.join(STAGE, 'api');
mkdirSync(apiStage, { recursive: true });
copyFileSync(path.join(API_SRC, 'package.json'), path.join(apiStage, 'package.json'));
copy(path.join(API_SRC, 'dist'), path.join(apiStage, 'dist'));
copy(path.join(API_SRC, 'prisma'), path.join(apiStage, 'prisma'));

step('compile prisma/seed.ts -> seed.js (no tsx at runtime)');
sh(pnpm, [
  '--filter', '@neurion/api', 'exec', 'tsc', 'prisma/seed.ts',
  '--outDir', path.join(apiStage, 'prisma'),
  '--module', 'commonjs', '--target', 'ES2021',
  '--esModuleInterop', '--skipLibCheck', '--moduleResolution', 'node',
]);

step('npm install api (prod)');
npmInstall(apiStage);

step('generate prisma client into staged node_modules');
// shell:false — process.execPath ("C:\\Program Files\\nodejs\\node.exe") has a space.
sh(process.execPath, [
  path.join(apiStage, 'node_modules', 'prisma', 'build', 'index.js'),
  'generate', '--schema', path.join(apiStage, 'prisma', 'schema.prisma'),
], { cwd: apiStage, shell: false });

// 3) stage web: .next build + config + prod node_modules
step('stage web');
const webStage = path.join(STAGE, 'web');
mkdirSync(webStage, { recursive: true });
copyFileSync(path.join(WEB_SRC, 'package.json'), path.join(webStage, 'package.json'));
copy(path.join(WEB_SRC, '.next'), path.join(webStage, '.next'));
for (const f of ['next.config.mjs', 'next.config.js', 'next.config.ts']) {
  const s = path.join(WEB_SRC, f);
  if (existsSync(s)) copyFileSync(s, path.join(webStage, f));
}
if (existsSync(path.join(WEB_SRC, 'public'))) copy(path.join(WEB_SRC, 'public'), path.join(webStage, 'public'));

step('npm install web (prod)');
npmInstall(webStage);

// 4) stage _desktop runtime dep: embedded-postgres (+ platform PG binary, pg).
// Minimal package.json so we don't drag electron/electron-builder into the app.
step('stage _desktop (embedded postgres)');
const dkStage = path.join(STAGE, '_desktop');
mkdirSync(dkStage, { recursive: true });
writeFileSync(
  path.join(dkStage, 'package.json'),
  JSON.stringify({ name: 'neurion-runtime-deps', version: '1.0.0', private: true, dependencies: { 'embedded-postgres': '18.4.0-beta.17' } }, null, 2),
);
npmInstall(dkStage);

// 4b) node-agent binary — powers the in-app "run a node" feature (needs Go)
step('build node-agent binary');
const nodeStage = path.join(STAGE, '_node');
mkdirSync(nodeStage, { recursive: true });
const nodeBin = path.join(nodeStage, isWin ? 'neurion-node.exe' : 'neurion-node');
const goBuild = spawnSync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', nodeBin, './cmd/neurion-node'], {
  cwd: path.join(ROOT, 'apps', 'node-agent'),
  stdio: 'inherit',
  shell: false,
});
if (goBuild.status !== 0) console.warn('⚠ node-agent build failed (is Go installed?) — the in-app node will be unavailable in this build');

// 5) runtime env. Do not copy the build machine's secrets or development ports
// into a distributable installer; the desktop creates per-install JWT secrets.
step('write desktop .env');
writeFileSync(
  path.join(STAGE, '.env'),
  [
    'NEURION_API_PORT=8091',
    'NEURION_WEB_PORT=3091',
    'JWT_ACCESS_TTL=30d',
    'AGENT_FS_CONFINE_TO_CWD=true',
    '',
  ].join('\n'),
);

console.log('\n✔ staging ready:', STAGE);
