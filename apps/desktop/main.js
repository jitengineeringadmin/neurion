// Neurion desktop (Electron) — launches the API + web, shows a native window,
// native folder dialog, app menu. Wraps the existing monorepo stack (Phase 1).
const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const API_DIR = path.join(ROOT, 'apps', 'api');
const WEB_DIR = path.join(ROOT, 'apps', 'web');
const WEB_URL = 'http://localhost:3091';
const API_HEALTH = 'http://localhost:8091/api/health';

const children = [];
let mainWindow = null;
let splash = null;

function parseEnv() {
  const env = { ...process.env };
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
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

function setStatus(text) {
  if (splash && !splash.isDestroyed()) splash.webContents.executeJavaScript(`window.setStatus && window.setStatus(${JSON.stringify(text)})`).catch(() => {});
}

async function startStack() {
  // 1) services (best-effort; Postgres is the only hard dependency)
  setStatus('avvio servizi (postgres)…');
  await run('docker', ['compose', 'up', '-d', 'postgres', 'redis', 'minio'], { cwd: ROOT, env: ENV });
  await waitPort('localhost', 5432, 25000);

  // 2) migrate (idempotent, best-effort)
  setStatus('preparo il database…');
  await run('npx', ['prisma', 'migrate', 'deploy'], { cwd: API_DIR, env: ENV });

  // 3) API
  setStatus('avvio API…');
  const api = sh('node', [path.join('dist', 'main.js')], { cwd: API_DIR, env: ENV });
  children.push(api);
  await waitHttp(API_HEALTH, 30000);

  // 4) web
  setStatus('avvio interfaccia…');
  const nextBin = path.join(WEB_DIR, 'node_modules', 'next', 'dist', 'bin', 'next');
  const web = sh('node', [nextBin, 'start', '-p', '3091'], { cwd: WEB_DIR, env: ENV });
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

app.on('before-quit', killChildren);
app.on('window-all-closed', () => {
  killChildren();
  app.quit();
});
