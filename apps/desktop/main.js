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

// Electron on Windows can surface a fatal "EPIPE: broken pipe, write" dialog
// when stdout/stderr disappear while child process output is being mirrored.
// Treat logging as best-effort so the desktop shell keeps running.
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', () => {});
}

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
let apiProc = null; // current API child process (the watchdog's restart target)
let restartingApi = false; // guard so only one API restart runs at a time
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
    updCheck: 'Check for updates',
    updTitle: 'Update available',
    updBody: (v, cur) => `Neurion ${v} is available (you have ${cur}).`,
    updNow: 'Download and install',
    updLater: 'Later',
    updNone: 'Neurion is up to date.',
    updFailed: 'Could not check for updates.',
    updDownloading: 'Downloading the update…',
    updReadyTitle: 'Update ready',
    updReadyBody: 'Neurion will close to complete the installation.',
    updInstall: 'Install now',
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
    updCheck: 'Controlla aggiornamenti',
    updTitle: 'Aggiornamento disponibile',
    updBody: (v, cur) => `È disponibile Neurion ${v} (hai la ${cur}).`,
    updNow: 'Scarica e installa',
    updLater: 'Più tardi',
    updNone: 'Neurion è aggiornato.',
    updFailed: 'Impossibile controllare gli aggiornamenti.',
    updDownloading: 'Download dell’aggiornamento…',
    updReadyTitle: 'Aggiornamento pronto',
    updReadyBody: 'Neurion si chiuderà per completare l’installazione.',
    updInstall: 'Installa ora',
  },
};
let T = STRINGS.en;

const sh = (cmd, args, opts = {}) => spawn(cmd, args, { shell: true, windowsHide: true, ...opts });

/** The app icon for whichever platform this is; .ico on Windows, .png elsewhere. */
function appIcon() {
  return path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
}

// --- boot log -------------------------------------------------------------
// Every child process the stack starts writes here, tagged. Without this a
// failed migrate / dead web server is completely invisible: the user only ever
// sees a stuck splash and "Neurion won't start" with no way to find out why.
let bootLogPath = null;
function bootLog(tag, text) {
  const line = `[${new Date().toISOString()}] [${tag}] ${String(text).replace(/\s+$/, '')}`;
  try {
    console.log(line);
  } catch {
    /* stdout may be gone */
  }
  try {
    if (!bootLogPath) bootLogPath = path.join(app.getPath('userData'), 'neurion-boot.log');
    fs.appendFileSync(bootLogPath, line + '\n');
  } catch {
    /* best effort */
  }
}

/** Mirror a child's stdout/stderr into the boot log, line by line. */
function attachLog(child, tag) {
  for (const [stream, suffix] of [
    [child.stdout, ''],
    [child.stderr, ':err'],
  ]) {
    if (!stream) continue;
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) bootLog(tag + suffix, l);
    });
  }
  child.on('error', (e) => bootLog(tag, `SPAWN ERROR: ${e && e.message}`));
  child.on('exit', (code, signal) => bootLog(tag, `exited code=${code} signal=${signal}`));
  return child;
}

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

function run(cmd, args, opts, tag = 'run') {
  return new Promise((resolve) => {
    const p = attachLog(sh(cmd, args, opts), tag);
    p.on('close', (code) => resolve(code ?? 0));
    p.on('error', () => resolve(1));
  });
}

// Run a JS file with Electron's embedded Node (ELECTRON_RUN_AS_NODE) so the
// packaged app needs no system Node. Args are passed directly (no shell).
function nodeSpawn(args, opts = {}, tag = null) {
  const p = spawn(process.execPath, args, {
    windowsHide: true,
    ...opts,
    env: { ...(opts.env || ENV), ELECTRON_RUN_AS_NODE: '1' },
  });
  return tag ? attachLog(p, tag) : p;
}
function nodeRun(args, opts, tag = 'node') {
  return new Promise((resolve) => {
    const p = nodeSpawn(args, opts, tag);
    p.on('close', (code) => resolve(code ?? 0));
    p.on('error', () => resolve(1));
  });
}

function setStatus(text) {
  if (splash && !splash.isDestroyed()) splash.webContents.executeJavaScript(`window.setStatus && window.setStatus(${JSON.stringify(text)})`).catch(() => {});
}

// --- API watchdog -----------------------------------------------------------
// A hung API (accepts the TCP connect but never answers) or a crashed one leaves
// the UI unable to load its data. waitHttp() cannot see a hung API (it gets neither
// a response nor an error), so probe with a HARD per-request timeout and, after a
// sustained outage, restart just the API process so the user is never stranded on an
// empty UI waiting for a manual relaunch.
function probeApi(timeoutMs = 6000) {
  return new Promise((resolve) => {
    const req = http.get(API_HEALTH, (res) => {
      const ok = res.statusCode === 200;
      res.resume();
      resolve(ok);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}

async function restartApi() {
  if (restartingApi || isQuitting) return;
  restartingApi = true;
  try {
    if (apiProc && apiProc.pid) {
      try {
        if (process.platform === 'win32') sh('taskkill', ['/pid', String(apiProc.pid), '/f', '/t']);
        else apiProc.kill('SIGTERM');
      } catch { /* already gone */ }
    }
    await waitPortFree('localhost', 8091, 8000);
    if (isQuitting) return;
    const api = nodeSpawn([path.join(API_DIR, 'dist', 'main.js')], { cwd: API_DIR, env: ENV });
    apiProc = api;
    children.push(api);
    let healthy = false;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && !isQuitting) {
      if (await probeApi(5000)) { healthy = true; break; }
      await new Promise((r) => setTimeout(r, 1500));
    }
    // Once the API answers again, reload the window so every page refetches its data.
    if (healthy && !isQuitting && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
  } finally {
    restartingApi = false;
  }
}

function startApiWatchdog() {
  let fails = 0;
  setInterval(async () => {
    if (restartingApi || isQuitting) return;
    if (await probeApi(6000)) { fails = 0; return; }
    fails += 1;
    // Only act after ~3 consecutive misses (~60-75s of real outage) so a brief
    // hiccup or one slow request never triggers a needless restart.
    if (fails >= 3) { fails = 0; await restartApi(); }
  }, 20000);
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
          "Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" | Where-Object { $_.CommandLine -like '*neurion*pgdata*' -or $_.CommandLine -like '*Neurion*app-stack*_desktop*postgres.exe*' -or $_.CommandLine -like '*embedded-postgres*windows-x64*native*bin*postgres.exe*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
        { windowsHide: true, timeout: 8000 },
      );
    } catch {
      /* best effort */
    }
  }
  clearStalePgLock();
  await Promise.all([
    waitPortFree('localhost', PG_PORT, 12000),
    waitPortFree('localhost', 8091, 12000),
    waitPortFree('localhost', 3091, 12000),
    // 8095 is the bundled llama.cpp server. It is a child of the API, so a
    // previous instance can still be holding the port while it dies.
    waitPortFree('localhost', 8095, 12000),
  ]);
}

// An unclean shutdown (crash, force-kill, forced close, an OS reboot) leaves
// pgdata/postmaster.pid behind. The next launch's embedded Postgres then refuses to
// start ("another server might be running"), the whole stack fails to come up, and the
// window is black. If that pid is not actually a live process, the lock is stale —
// remove it so Postgres (and the app) start normally on reopen.
function clearStalePgLock() {
  try {
    const pidFile = path.join(app.getPath('userData'), 'pgdata', 'postmaster.pid');
    if (!fs.existsSync(pidFile)) return;
    const pid = parseInt(String(fs.readFileSync(pidFile, 'utf8')).split('\n')[0].trim(), 10);
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); alive = true; } catch (e) { alive = !!e && e.code === 'EPERM'; }
    }
    if (!alive) fs.rmSync(pidFile, { force: true });
  } catch {
    /* best effort */
  }
}

// A stable fingerprint of the applied migration set: count + latest folder name.
// Changes only when a new migration ships, so an unchanged install can skip `migrate`.
function migrationsFingerprint() {
  try {
    const dir = path.join(API_DIR, 'prisma', 'migrations');
    const subs = fs.readdirSync(dir).filter((d) => /^\d/.test(d)).sort();
    return subs.length ? `${subs.length}:${subs[subs.length - 1]}` : '';
  } catch {
    return '';
  }
}

async function startStack() {
  // children + tooling all use the embedded DB
  ENV.DATABASE_URL = DB_URL;
  // Desktop ports are part of the packaged runtime contract. Never inherit the
  // monorepo development ports from a build-machine .env file.
  ENV.NEURION_API_PORT = '8091';
  ENV.NEURION_WEB_PORT = '3091';
  // Personal desktop: keep the user signed in across restarts (a 30-day access token
  // in localStorage) instead of re-prompting every launch. Prod/web keeps the 15m default.
  ENV.JWT_ACCESS_TTL = ENV.JWT_ACCESS_TTL || '30d';
  // Personal machine: the app signs itself in as this installation's owner
  // instead of showing a login form. Nothing here is being protected from
  // anyone — whoever is logged into this computer already owns the database,
  // the models and the files. The API refuses to honour this unless it is also
  // bound to loopback, so the two settings cannot drift apart.
  ENV.NEURION_LOCAL_OWNER = 'true';
  ensureSecrets();

  // Local image engine (stable-diffusion.cpp) lives under userData; the API downloads
  // the binary + model here on first use (persists across updates). One-click, no deps.
  try {
    const imgDir = path.join(app.getPath('userData'), 'image-engine');
    fs.mkdirSync(imgDir, { recursive: true });
    ENV.NEURION_IMAGE_DIR = imgDir;
    // Same treatment for the bundled text engine (llama.cpp + a GGUF model), so
    // chat works on a machine that has never heard of ollama. Kept out of the
    // installer and fetched on first use, exactly like the image engine.
    const textDir = path.join(app.getPath('userData'), 'text-engine');
    fs.mkdirSync(textDir, { recursive: true });
    ENV.NEURION_TEXT_DIR = textDir;
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

  // 2) Web starts NOW — it does not need the database, so its ~8s Next.js startup
  //    overlaps the migrate + API boot below instead of stacking after them. This is
  //    the biggest single cut to "time until the window is usable". The browser calls
  //    the API directly (localhost:8091), so the web host needs no DB to start.
  setStatus(T.web);
  const nextBin = path.join(WEB_DIR, 'node_modules', 'next', 'dist', 'bin', 'next');
  bootLog('web', `spawning ${nextBin} (cwd=${WEB_DIR})`);
  // -H 127.0.0.1: same reason the API binds loopback — this is a personal
  // desktop, the UI has no business being reachable from the rest of the LAN.
  const web = nodeSpawn([nextBin, 'start', '-p', '3091', '-H', '127.0.0.1'], { cwd: WEB_DIR, env: ENV }, 'web');
  children.push(web);

  // 3) migrate — but only when the migration set actually changed (after an update).
  //    An unchanged DB re-runs `migrate deploy` for nothing on every launch; skip it.
  //    Marker is written only after a successful migrate, so a failure re-tries next boot.
  setStatus(T.prep);
  const markerFile = path.join(app.getPath('userData'), '.migrated');
  const fp = migrationsFingerprint();
  let applied = '';
  try { applied = fs.readFileSync(markerFile, 'utf8').trim(); } catch { /* no marker yet */ }
  if (firstRun || !fp || applied !== fp) {
    bootLog('migrate', `applying migrations (marker=${applied || 'none'} -> ${fp})`);
    // Always drive Prisma through Electron's embedded Node. The old dev branch
    // shelled out to `npx`, which fails inside the Electron main process — the
    // failure was silent, so the API then booted against a stale schema and
    // crash-looped on the first missing table.
    const prismaCli = path.join(API_DIR, 'node_modules', 'prisma', 'build', 'index.js');
    const code = await nodeRun([prismaCli, 'migrate', 'deploy'], { cwd: API_DIR, env: ENV }, 'migrate');
    if (code !== 0) {
      throw new Error(`database migration failed (exit ${code}) — see ${bootLogPath}`);
    }
    if (firstRun) {
      const seedJs = path.join(API_DIR, 'prisma', 'seed.js');
      const seedArgs = fs.existsSync(seedJs)
        ? [seedJs]
        : [path.join(API_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(API_DIR, 'prisma', 'seed.ts')];
      const seedCode = await nodeRun(seedArgs, { cwd: API_DIR, env: ENV }, 'seed');
      if (seedCode !== 0) bootLog('seed', `WARNING: seed failed (exit ${seedCode}) — continuing`);
    }
    if (fp) { try { fs.writeFileSync(markerFile, fp); } catch { /* best effort */ } }
  }

  // 4) API — retry once. A just-freed port or a cold/recovering DB can miss the first
  //    boot; a fresh spawn on the second attempt clears the "engine didn't respond"
  //    race instead of failing the whole launch.
  setStatus(T.api);
  let apiUp = false;
  for (let attempt = 0; attempt < 2 && !apiUp; attempt++) {
    const api = nodeSpawn([path.join(API_DIR, 'dist', 'main.js')], { cwd: API_DIR, env: ENV }, `api#${attempt + 1}`);
    apiProc = api;
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
  if (!apiUp) throw new Error(`local engine did not respond — see ${bootLogPath}`);
  bootLog('api', 'healthy');

  // 5) make sure web finished coming up too (it has been starting since step 2).
  //    Its result was previously discarded, so a dead web server still led to a
  //    main window pointed at a refused connection (blank app, no explanation).
  setStatus(T.almost);
  if (!(await waitHttp(WEB_URL, 40000))) {
    throw new Error(`web interface did not respond on ${WEB_URL} — see ${bootLogPath}`);
  }
  bootLog('web', 'healthy');
}

function createSplash() {
  splash = new BrowserWindow({
    width: 420,
    height: 320,
    frame: false,
    resizable: false,
    backgroundColor: '#04070a',
    // The splash is the FIRST window a user sees, and it had no icon — so the
    // taskbar showed Electron's default logo for the whole startup, which is
    // the icon most people end up looking at longest.
    icon: appIcon(),
    webPreferences: { contextIsolation: true },
  });
  splash.loadFile(path.join(__dirname, 'splash.html'));
}

/** Boot failed: say why, and offer to open the log instead of a blank window. */
function showBootFailure(message) {
  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title: T.failTitle,
    message: T.failTitle,
    detail: `${message}\n\n${bootLogPath || ''}`,
    buttons: [T.quit, 'Apri log'],
    defaultId: 1,
    cancelId: 0,
  });
  if (choice === 1 && bootLogPath) shell.openPath(bootLogPath);
  isQuitting = true;
  stopAll();
  app.quit();
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#04070a',
    title: 'Neurion',
    icon: appIcon(),
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

// --- updates --------------------------------------------------------------
const { compareVersions, fetchManifest, downloadVerified } = require('./updater');

const UPDATE_MANIFEST_URL =
  process.env.NEURION_UPDATE_URL || 'https://neurionproject.org/download/latest.json';
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let updateInFlight = false;

/**
 * Check the manifest and, if the user agrees, download + launch the installer.
 * `silent` suppresses the "already up to date" / failure dialogs (startup run).
 */
async function checkForUpdates(silent = true) {
  if (updateInFlight) return;
  updateInFlight = true;
  try {
    const current = app.getVersion();
    const manifest = await fetchManifest(UPDATE_MANIFEST_URL);
    const latest = String(manifest.version || '');
    if (!latest || compareVersions(latest, current) <= 0) {
      bootLog('update', `up to date (current ${current}, published ${latest || 'n/a'})`);
      if (!silent) {
        dialog.showMessageBox({ type: 'info', title: 'Neurion', message: T.updNone, detail: `v${current}` });
      }
      return;
    }
    bootLog('update', `update available: ${current} -> ${latest}`);
    const choice = dialog.showMessageBoxSync({
      type: 'info',
      title: T.updTitle,
      message: T.updTitle,
      detail: `${T.updBody(latest, current)}${manifest.notes ? `\n\n${manifest.notes}` : ''}`,
      buttons: [T.updLater, T.updNow],
      defaultId: 1,
      cancelId: 0,
    });
    if (choice !== 1) return;

    const url = new URL(manifest.url, UPDATE_MANIFEST_URL).href;
    setStatus(T.updDownloading);
    const bin = await downloadVerified(url, manifest.sha256, {
      allowInsecure: /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url),
    });

    const target = path.join(app.getPath('temp'), `Neurion-Setup-${latest}.exe`);
    fs.writeFileSync(target, bin);
    bootLog('update', `downloaded + verified ${target} (${bin.length} bytes)`);

    dialog.showMessageBoxSync({
      type: 'info',
      title: T.updReadyTitle,
      message: T.updReadyTitle,
      detail: T.updReadyBody,
      buttons: [T.updInstall],
      defaultId: 0,
    });
    spawn(target, [], { detached: true, stdio: 'ignore' }).unref();
    isQuitting = true;
    stopAll();
    app.quit();
  } catch (e) {
    bootLog('update', `check failed: ${(e && e.message) || e}`);
    if (!silent) {
      dialog.showMessageBox({ type: 'warning', title: 'Neurion', message: T.updFailed, detail: String((e && e.message) || e) });
    }
  } finally {
    updateInFlight = false;
  }
}

function startUpdateChecks() {
  if (!PACKAGED) {
    bootLog('update', 'dev run — update checks disabled');
    return;
  }
  setTimeout(() => void checkForUpdates(true), 30_000);
  setInterval(() => void checkForUpdates(true), UPDATE_INTERVAL_MS);
}

function buildMenu() {
  const template = [
    {
      label: 'Neurion',
      submenu: [
        { label: T.about, click: () => dialog.showMessageBox(mainWindow, { title: 'Neurion', message: 'Neurion desktop', detail: `${T.aboutDetail} v${app.getVersion()}` }) },
        { type: 'separator' },
        { label: T.updCheck, click: () => void checkForUpdates(false) },
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
    const token = (creds && creds.token) || '';
    const email = (creds && creds.email) || '';
    const password = (creds && creds.password) || '';
    // Prefer the already-signed-in token (no need to retype the password); fall back to creds.
    const authArgs = token ? ['--token', token] : email && password ? ['--email', email, '--password', password] : null;
    if (!authArgs) return { ok: false, error: 'credentials required' };
    const reg = spawnSync(
      NODE_BIN,
      ['register', '--api', NODE_API, ...authArgs, '--name', os.hostname() || 'neurion-node', '--realtime', '--realtime-base-url', 'http://127.0.0.1:11434/v1'],
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
    // Windows groups taskbar buttons and resolves their icon by AppUserModelID.
    // Without one, Electron's default is used and a pinned Neurion does not
    // match the running window. Must be set before any window is created, and
    // must equal the installer's appId.
    if (process.platform === 'win32') app.setAppUserModelId('org.neurionproject.desktop');
    buildMenu();
    createSplash();
    let bootError = null;
    try {
      await startStack();
    } catch (e) {
      bootError = (e && e.message) || String(e);
      bootLog('boot', `FAILED: ${bootError}`);
      setStatus(T.error + bootError);
    }
    // A failed boot used to be papered over: the main window opened anyway and
    // loaded a URL nothing was serving. Show the reason and where the log is.
    if (bootError) {
      showBootFailure(bootError);
      createTray();
      return;
    }
    createMainWindow();
    createTray();
    startApiWatchdog();
    startUpdateChecks();
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
