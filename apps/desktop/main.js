// Neurion desktop (Electron) — launches the API + web, shows a native window,
// native folder dialog, app menu. Wraps the existing monorepo stack (Phase 1).
const { app, BrowserWindow, Menu, Tray, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
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

// In-app node: the bundled node-agent binary connects to the PRODUCTION network
// (registers under the user's neurionproject.org account, serves the local ollama
// models over the realtime lane) so a desktop user can earn NRN with one click.
const NODE_BIN = PACKAGED
  ? path.join(STACK, '_node', process.platform === 'win32' ? 'neurion-node.exe' : 'neurion-node')
  : path.join(ROOT, 'apps', 'node-agent', 'bin', process.platform === 'win32' ? 'neurion-node.exe' : 'neurion-node');
const NODE_API = process.env.NEURION_NODE_API || 'https://neurionproject.org';
const nodeConfigPath = () => path.join(app.getPath('userData'), 'neurion-node.yaml');

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
let nodeProc = null;
let tray = null;
let isQuitting = false;

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

// Startup strings follow the OS language (app.getLocale → en/it; anything else
// falls back to English). Resolved at app-ready time (getLocale needs ready).
const STRINGS = {
  en: {
    boot: 'Starting…',
    dbFirst: 'First launch — preparing the local database (this can take a minute)…',
    db: 'Starting local database…',
    prep: 'Updating database…',
    api: 'Starting engine…',
    web: 'Starting interface…',
    almost: 'Almost ready…',
    error: 'Startup error: ',
    openBrowser: 'Open in browser',
    quit: 'Quit',
    trayOpen: 'Open Neurion',
    trayQuit: 'Quit Neurion (stops your node)',
    trayAutostart: 'Start at login',
    edit: 'Edit',
    view: 'View',
    window: 'Window',
    about: 'About Neurion',
    aboutDetail: 'Distributed AI compute + agent.',
    pickFolder: 'Select the project folder',
    failTitle: 'Neurion won’t start',
    failBody: 'The local engine did not respond. Fully close Neurion and reopen it.<br/>If it persists, restart your PC or reinstall.',
  },
  it: {
    boot: 'Avvio…',
    dbFirst: 'Primo avvio — preparazione del database locale (può richiedere un minuto)…',
    db: 'Avvio database locale…',
    prep: 'Aggiornamento database…',
    api: 'Avvio motore…',
    web: 'Avvio interfaccia…',
    almost: 'Quasi pronto…',
    error: 'Errore di avvio: ',
    openBrowser: 'Apri nel browser',
    quit: 'Esci',
    trayOpen: 'Apri Neurion',
    trayQuit: 'Esci da Neurion (ferma il tuo node)',
    trayAutostart: "Avvia all'accensione",
    edit: 'Modifica',
    view: 'Vista',
    window: 'Finestra',
    about: 'Informazioni su Neurion',
    aboutDetail: 'Calcolo AI distribuito + agente.',
    pickFolder: 'Seleziona la cartella del progetto',
    failTitle: 'Neurion non si avvia',
    failBody: 'Il motore locale non ha risposto. Chiudi completamente Neurion e riaprilo.<br/>Se persiste, riavvia il PC o reinstalla.',
  },
};
let T = STRINGS.en;

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

// Inverse of waitPort: resolves true once nothing is listening on the port (i.e.
// a dying previous instance has released it). Used to make an in-place update
// relaunch wait for the old stack's ports before binding the new one.
function waitPortFree(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const s = net.connect({ host, port }, () => {
        s.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tick, 500);
      });
      s.on('error', () => {
        s.destroy();
        resolve(true); // connect failed => port is free
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

function loadPgClient() {
  const base = PACKAGED ? path.join(STACK, '_desktop', 'node_modules', 'pg') : 'pg';
  return require(base).Client; // pg is a dependency of embedded-postgres
}

// initdb on Windows defaults the cluster to WIN1252, which cannot store emoji /
// non-Latin1 text. Create the app database as UTF8 from template0 (allowed even
// on a WIN1252 cluster) so chat content of any language is stored correctly.
async function ensureUtf8Database() {
  const Client = loadPgClient();
  const admin = new Client({ host: 'localhost', port: PG_PORT, user: PG_USER, password: PG_PASS, database: 'postgres' });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT pg_encoding_to_char(encoding) AS enc FROM pg_database WHERE datname = $1', [PG_DB]);
    if (rows.length === 0) {
      await admin.query(`CREATE DATABASE "${PG_DB}" ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`);
    }
  } finally {
    await admin.end();
  }
}

async function startDb() {
  const EmbeddedPostgres = await loadEmbeddedPostgres();
  const dataDir = path.join(app.getPath('userData'), 'pgdata');
  pg = new EmbeddedPostgres({ databaseDir: dataDir, user: PG_USER, password: PG_PASS, port: PG_PORT, persistent: true });
  const init = pg.initialise || pg.initialize;
  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) await init.call(pg);
  await pg.start();
  await ensureUtf8Database();
  await waitPort('localhost', PG_PORT, 25000);
}

// The packaged build may ship without a .env (CI has no repo-root .env to copy),
// so the API would start with no JWT secret and every login would 500. Generate
// the secrets once per install and persist them in userData so issued tokens
// survive restarts and app updates.
function ensureSecrets() {
  const dir = app.getPath('userData');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* exists */
  }
  const file = path.join(dir, 'secrets.json');
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* none yet */
  }
  let changed = false;
  for (const k of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
    if (!s[k]) {
      s[k] = require('node:crypto').randomBytes(48).toString('hex');
      changed = true;
    }
    ENV[k] = s[k]; // ALWAYS load from the persisted store so tokens survive restarts
  }
  // Persist so the JWT secret is STABLE across launches — otherwise every restart
  // regenerates it, invalidating all tokens, and the user must log in every time.
  // (No POSIX mode option: it can throw on Windows and silently drop persistence.)
  if (changed) {
    try {
      fs.writeFileSync(file, JSON.stringify(s), 'utf8');
    } catch (e) {
      console.error('[neurion] could not persist secrets.json — sessions will not survive restarts:', e && e.message);
    }
  }
}

// An in-place update relaunches the app while the previous instance's stack may
// still be shutting down, so its DB/API/web ports linger for a few seconds. The
// fresh stack then fails to bind and shows "engine didn't respond". Reclaim first:
// kill our orphan embedded Postgres, then wait (bounded) for the ports to free up.
async function reclaimStack() {
  if (process.platform === 'win32') {
    try {
      spawnSync(
        'powershell',
        ['-NoProfile', '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" | Where-Object { $_.CommandLine -like '*neurion*pgdata*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
        { windowsHide: true, timeout: 8000 },
      );
    } catch {
      /* best effort */
    }
  }
  await Promise.all([
    waitPortFree('localhost', PG_PORT, 12000),
    waitPortFree('localhost', 8091, 12000),
    waitPortFree('localhost', 3091, 12000),
  ]);
}

async function startStack() {
  // children + tooling all use the embedded DB
  ENV.DATABASE_URL = DB_URL;
  // Personal desktop: keep the user signed in across restarts (a 30-day access token
  // in localStorage) instead of re-prompting every launch. Prod/web keeps the 15m default.
  ENV.JWT_ACCESS_TTL = ENV.JWT_ACCESS_TTL || '30d';
  ensureSecrets();

  // Local image engine (stable-diffusion.cpp) lives under userData; the API downloads
  // the binary + model here on first use (persists across updates). One-click, no deps.
  try {
    const imgDir = path.join(app.getPath('userData'), 'image-engine');
    fs.mkdirSync(imgDir, { recursive: true });
    ENV.NEURION_IMAGE_DIR = imgDir;
  } catch {
    /* best effort — image gen just stays unavailable */
  }

  // free ports held by a not-yet-dead previous instance (in-place update race)
  await reclaimStack();

  // first run = no Postgres cluster yet (the slow initdb path) — drives both the
  // splash message and whether we seed.
  const dataDir = path.join(app.getPath('userData'), 'pgdata');
  const firstRun = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));

  // 1) embedded Postgres (no Docker)
  setStatus(firstRun ? T.dbFirst : T.db);
  await startDb();

  // 2) migrate always (schema can change between versions); seed only on first
  //    run — it is idempotent but spawning it every launch just slows startup.
  setStatus(T.prep);
  if (PACKAGED) {
    await nodeRun([path.join(API_DIR, 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'], { cwd: API_DIR, env: ENV });
    if (firstRun) await nodeRun([path.join(API_DIR, 'prisma', 'seed.js')], { cwd: API_DIR, env: ENV });
  } else {
    await run('npx', ['prisma', 'migrate', 'deploy'], { cwd: API_DIR, env: ENV });
    if (firstRun) await run('npx', ['tsx', path.join('prisma', 'seed.ts')], { cwd: API_DIR, env: ENV });
  }

  // 3) API — retry once. A just-freed port or a cold/recovering DB can miss the
  // first boot; a fresh spawn on the second attempt clears the "engine didn't
  // respond" race instead of failing the whole launch.
  setStatus(T.api);
  let apiUp = false;
  for (let attempt = 0; attempt < 2 && !apiUp; attempt++) {
    const api = nodeSpawn([path.join(API_DIR, 'dist', 'main.js')], { cwd: API_DIR, env: ENV });
    children.push(api);
    apiUp = await waitHttp(API_HEALTH, 45000);
    if (!apiUp) {
      try {
        if (process.platform === 'win32') sh('taskkill', ['/pid', String(api.pid), '/f', '/t']);
        else api.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      await waitPortFree('localhost', 8091, 6000);
    }
  }
  if (!apiUp) throw new Error('local engine did not respond');

  // 4) web
  setStatus(T.web);
  const nextBin = path.join(WEB_DIR, 'node_modules', 'next', 'dist', 'bin', 'next');
  const web = nodeSpawn([nextBin, 'start', '-p', '3091'], { cwd: WEB_DIR, env: ENV });
  children.push(web);
  await waitHttp(WEB_URL, 40000);
  setStatus(T.almost);
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
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  mainWindow.loadURL(WEB_URL);

  // Windows/Chromium can leave the newly-exposed region unpainted after a maximize
  // (content looks frozen at the old size until you interact). Force a repaint on
  // every window-size change so the layout fills the window immediately.
  const repaint = () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.invalidate();
  };
  for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    mainWindow.on(ev, repaint);
  }
  // The web server may take a moment after this point; retry instead of showing
  // a black window, and fall back to a readable error page (never a dead URL).
  let loadTries = 0;
  mainWindow.webContents.on('did-fail-load', (_e, code) => {
    if (code === -3) return; // aborted (a newer navigation superseded this one)
    if (++loadTries <= 25) {
      setTimeout(() => mainWindow && !mainWindow.isDestroyed() && mainWindow.loadURL(WEB_URL), 1000);
    } else {
      mainWindow.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            `<body style="background:#04070a;color:#dff6e6;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center"><div><h2 style="color:#00ff70">${T.failTitle}</h2><p style="color:#7fa890">${T.failBody}</p></div></body>`,
          ),
      );
      if (splash && !splash.isDestroyed()) splash.destroy();
      mainWindow.show();
    }
  });
  mainWindow.once('ready-to-show', () => {
    if (splash && !splash.isDestroyed()) splash.destroy();
    mainWindow.show();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // Closing the window hides it to the tray (so the embedded stack + any running
  // node keep going). Real exit is the tray's "Quit".
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function autostartFile() {
  return path.join(os.homedir(), '.config', 'autostart', 'neurion.desktop');
}
function getAutoStart() {
  try {
    if (process.platform === 'linux') return fs.existsSync(autostartFile());
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}
function setAutoStart(on) {
  try {
    if (process.platform === 'linux') {
      const p = autostartFile();
      if (on) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, `[Desktop Entry]\nType=Application\nName=Neurion\nExec=${process.execPath}\nX-GNOME-Autostart-enabled=true\n`);
      } else if (fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
    } else {
      app.setLoginItemSettings({ openAtLogin: on });
    }
  } catch {
    /* best effort */
  }
}

function createTray() {
  const iconFile = path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  try {
    tray = new Tray(iconFile);
  } catch {
    return; // no icon available — stay a plain window app
  }
  tray.setToolTip('Neurion');
  const show = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  };
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: T.trayOpen, click: show },
      { label: T.trayAutostart, type: 'checkbox', checked: getAutoStart(), click: (item) => setAutoStart(item.checked) },
      { type: 'separator' },
      { label: T.trayQuit, click: () => { isQuitting = true; app.quit(); } },
    ]),
  );
  tray.on('click', show);
  tray.on('double-click', show);
}

function buildMenu() {
  const template = [
    {
      label: 'Neurion',
      submenu: [
        { label: T.about, click: () => dialog.showMessageBox(mainWindow, { title: 'Neurion', message: 'Neurion desktop', detail: `${T.aboutDetail} v${app.getVersion()}` }) },
        { type: 'separator' },
        { label: T.openBrowser, click: () => shell.openExternal(WEB_URL) },
        { label: T.trayAutostart, type: 'checkbox', checked: getAutoStart(), click: (item) => setAutoStart(item.checked) },
        { type: 'separator' },
        { role: 'quit', label: T.quit },
      ],
    },
    { label: T.edit, submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: T.view, submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: T.window, submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('pick-folder', async (_e, initial) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: T.pickFolder,
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: initial || undefined,
  });
  return { path: res.canceled || !res.filePaths[0] ? null : res.filePaths[0].replace(/\\/g, '/') };
});

// Native file picker for a user's own image model (.safetensors / .gguf / .ckpt).
ipcMain.handle('pick-model', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Neurion',
    properties: ['openFile'],
    filters: [{ name: 'Image model', extensions: ['safetensors', 'gguf', 'ckpt'] }],
  });
  if (res.canceled || !res.filePaths[0]) return { path: null };
  const p = res.filePaths[0].replace(/\\/g, '/');
  return { path: p, name: p.split('/').pop() };
});

// --- in-app node: register once on the production network, then run/stop it ---
ipcMain.handle('node:status', () => ({
  running: !!nodeProc,
  registered: fs.existsSync(nodeConfigPath()),
  available: fs.existsSync(NODE_BIN),
}));

ipcMain.handle('node:start', (_e, creds) => {
  if (nodeProc) return { ok: true, running: true };
  if (!fs.existsSync(NODE_BIN)) return { ok: false, error: 'node binary not bundled in this build' };
  const cfg = nodeConfigPath();
  if (!fs.existsSync(cfg)) {
    const email = (creds && creds.email) || '';
    const password = (creds && creds.password) || '';
    if (!email || !password) return { ok: false, error: 'credentials required' };
    const reg = spawnSync(
      NODE_BIN,
      ['register', '--api', NODE_API, '--email', email, '--password', password, '--name', os.hostname() || 'neurion-node', '--realtime', '--realtime-base-url', 'http://127.0.0.1:11434/v1'],
      { cwd: app.getPath('userData'), windowsHide: true, encoding: 'utf8' },
    );
    if (reg.status !== 0) return { ok: false, error: ((reg.stderr || reg.stdout || 'register failed') + '').trim().slice(-400) };
  }
  nodeProc = spawn(NODE_BIN, ['start', '--config', cfg], { cwd: app.getPath('userData'), windowsHide: true });
  nodeProc.on('exit', () => { nodeProc = null; });
  return { ok: true, running: true };
});

ipcMain.handle('node:stop', () => {
  stopNode();
  return { ok: true };
});

// Single instance: a second launch must not spin up a second embedded stack
// (it would fight for ports 5433/8091/3091 and leave one window black). Focus
// the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    T = STRINGS[(app.getLocale() || 'en').slice(0, 2)] || STRINGS.en;
    buildMenu();
    createSplash();
    try {
      await startStack();
    } catch (e) {
      setStatus('errore avvio: ' + (e && e.message ? e.message : e));
    }
    createMainWindow();
    createTray();
  });
}

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

function stopNode() {
  if (!nodeProc) return;
  try {
    if (process.platform === 'win32') sh('taskkill', ['/pid', String(nodeProc.pid), '/f', '/t']);
    else nodeProc.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  nodeProc = null;
}

function stopAll() {
  stopNode();
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
  // The window hides to the tray instead of closing, so this normally won't fire;
  // only really exit when the user chose Quit.
  if (isQuitting) {
    stopAll();
    app.quit();
  }
});
