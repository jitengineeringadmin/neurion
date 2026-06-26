// Neurion desktop (Electron) — launches the API + web, shows a native window,
// native folder dialog, app menu. Wraps the existing monorepo stack (Phase 1).
const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

// In a packaged build the stack lives under resources/app-stack (extraResources);
// in dev it is the monorepo working tree.
const PACKAGED = app.isPackaged;
const ROOT = path.resolve(__dirname, '..', '..');
const STACK = PACKAGED ? path.join(process.resourcesPath, 'app-stack') : ROOT;
const API_DIR = PACKAGED ? path.join(STACK, 'api') : path.join(ROOT, 'apps', 'api');
const WEB_DIR = PACKAGED ? path.join(STACK, 'web') : path.join(ROOT, 'apps', 'web');
const ENV_PATH = PACKAGED ? path.join(STACK, '.env') : path.join(ROOT, '.env');
const WEB_URL = 'http://localhost:3091';
const API_HEALTH = 'http://localhost:8091/api/health';

// Embedded Postgres — standalone, no Docker.
const PG_PORT = 5433;
const PG_USER = 'neurion';
const PG_PASS = 'neurion';
const PG_DB = 'neurion';
const DB_URL = `postgresql://${PG_USER}:${PG_PASS}@localhost:${PG_PORT}/${PG_DB}`;

const children = [];
let pg = null;
let mainWindow = null;
let splash = null;

function parseEnv() {
  const env = { ...process.env };
  try {
    const txt = fs.readFileSync(ENV_PATH, 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/(^"|"$)/g, '');
    }
  } catch {
    /* no .env */
  }
  return env;
}
const ENV = parseEnv();

const sh = (cmd, args, opts = {}) => spawn(cmd, args, { shell: true, windowsHide: true, ...opts });

function waitPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const s = net.connect({ host, port }, () => {
        s.destroy();
        resolve(true);
      });
      s.on('error', () => {
        s.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tick, 600);
      });
    };
    tick();
  });
}

function waitHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      http
        .get(url, (res) => {
          res.destroy();
          resolve(true);
        })
        .on('error', () => {
          if (Date.now() > deadline) resolve(false);
          else setTimeout(tick, 700);
        });
    };
    tick();
  });
}

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const p = sh(cmd, args, opts);
    p.on('close', (code) => resolve(code ?? 0));
    p.on('error', () => resolve(1));
  });
}

// Run a JS file with Electron's embedded Node (ELECTRON_RUN_AS_NODE) so the
// packaged app needs no system Node. Args are passed directly (no shell).
function nodeSpawn(args, opts = {}) {
  return spawn(process.execPath, args, {
    windowsHide: true,
    ...opts,
    env: { ...(opts.env || ENV), ELECTRON_RUN_AS_NODE: '1' },
  });
}
function nodeRun(args, opts) {
  return new Promise((resolve) => {
    const p = nodeSpawn(args, opts);
    p.on('close', (code) => resolve(code ?? 0));
    p.on('error', () => resolve(1));
  });
}

function setStatus(text) {
  if (splash && !splash.isDestroyed()) splash.webContents.executeJavaScript(`window.setStatus && window.setStatus(${JSON.stringify(text)})`).catch(() => {});
}

async function loadEmbeddedPostgres() {
  // ESM package -> dynamic import from CJS. In a packaged build it is vendored
  // under app-stack/_desktop (extraResources); in dev it is a normal dependency.
  if (PACKAGED) {
    const entry = path.join(STACK, '_desktop', 'node_modules', 'embedded-postgres', 'dist', 'index.js');
    const mod = await import(pathToFileURL(entry).href);
    return mod.default || mod;
  }
  const mod = await import('embedded-postgres');
  return mod.default || mod;
}

async function startDb() {
  const EmbeddedPostgres = await loadEmbeddedPostgres();
  const dataDir = path.join(app.getPath('userData'), 'pgdata');
  pg = new EmbeddedPostgres({ databaseDir: dataDir, user: PG_USER, password: PG_PASS, port: PG_PORT, persistent: true });
  const init = pg.initialise || pg.initialize;
  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) await init.call(pg);
  await pg.start();
  try {
    await pg.createDatabase(PG_DB);
  } catch {
    /* already exists */
  }
  await waitPort('localhost', PG_PORT, 25000);
}

async function startStack() {
  // children + tooling all use the embedded DB
  ENV.DATABASE_URL = DB_URL;

  // 1) embedded Postgres (no Docker)
  setStatus('avvio database integrato…');
  await startDb();

  // 2) migrate + seed (idempotent)
  setStatus('preparo il database…');
  if (PACKAGED) {
    await nodeRun([path.join(API_DIR, 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'], { cwd: API_DIR, env: ENV });
    await nodeRun([path.join(API_DIR, 'prisma', 'seed.js')], { cwd: API_DIR, env: ENV });
  } else {
    await run('npx', ['prisma', 'migrate', 'deploy'], { cwd: API_DIR, env: ENV });
    await run('npx', ['tsx', path.join('prisma', 'seed.ts')], { cwd: API_DIR, env: ENV });
  }

  // 3) API
  setStatus('avvio API…');
  const api = nodeSpawn([path.join(API_DIR, 'dist', 'main.js')], { cwd: API_DIR, env: ENV });
  children.push(api);
  await waitHttp(API_HEALTH, 30000);

  // 4) web
  setStatus('avvio interfaccia…');
  const nextBin = path.join(WEB_DIR, 'node_modules', 'next', 'dist', 'bin', 'next');
  const web = nodeSpawn([nextBin, 'start', '-p', '3091'], { cwd: WEB_DIR, env: ENV });
  children.push(web);
  await waitHttp(WEB_URL, 40000);
}

function createSplash() {
  splash = new BrowserWindow({
    width: 420,
    height: 320,
    frame: false,
    resizable: false,
    backgroundColor: '#04070a',
    webPreferences: { contextIsolation: true },
  });
  splash.loadFile(path.join(__dirname, 'splash.html'));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#04070a',
    title: 'Neurion',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  mainWindow.loadURL(WEB_URL);
  mainWindow.once('ready-to-show', () => {
    if (splash && !splash.isDestroyed()) splash.destroy();
    mainWindow.show();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function buildMenu() {
  const template = [
    {
      label: 'Neurion',
      submenu: [
        { label: 'About Neurion', click: () => dialog.showMessageBox(mainWindow, { title: 'Neurion', message: 'Neurion desktop', detail: 'Distributed AI compute + agent. v1.2.0' }) },
        { type: 'separator' },
        { label: 'Apri nel browser', click: () => shell.openExternal(WEB_URL) },
        { type: 'separator' },
        { role: 'quit', label: 'Esci' },
      ],
    },
    { label: 'Modifica', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Vista', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Finestra', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('pick-folder', async (_e, initial) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Seleziona la cartella del progetto',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: initial || undefined,
  });
  return { path: res.canceled || !res.filePaths[0] ? null : res.filePaths[0].replace(/\\/g, '/') };
});

app.whenReady().then(async () => {
  buildMenu();
  createSplash();
  try {
    await startStack();
  } catch (e) {
    setStatus('errore avvio: ' + (e && e.message ? e.message : e));
  }
  createMainWindow();
});

function killChildren() {
  for (const c of children) {
    try {
      if (process.platform === 'win32') sh('taskkill', ['/pid', String(c.pid), '/f', '/t']);
      else c.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}

function stopAll() {
  killChildren();
  if (pg) {
    try {
      pg.stop();
    } catch {
      /* ignore */
    }
  }
}

app.on('before-quit', stopAll);
app.on('window-all-closed', () => {
  stopAll();
  app.quit();
});
