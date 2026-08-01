#!/usr/bin/env bash
# Neurion online deploy — stands up API + web on a server, with a local ollama
# fallback engine, behind the existing nginx vhost for neurionproject.org.
#
# Idempotent. Touches ONLY: the neurion postgres role/db, /opt/neurion,
# neurion-* systemd units, and the neurionproject nginx site. Other sites on
# the box are never modified. Run as root from /opt/neurion after the repo
# tree has been extracted there.
set -euo pipefail
APP=/opt/neurion
cd "$APP"
echo "### [1/8] toolchain (pnpm via corepack)"
corepack enable >/dev/null 2>&1 || true
corepack prepare pnpm@8.12.1 --activate
export PNPM_HOME="${PNPM_HOME:-/root/.local/share/pnpm}"; export PATH="$PNPM_HOME:$PATH"
export ELECTRON_SKIP_BINARY_DOWNLOAD=1   # never pull the electron binary on a server
export CI=true                            # pnpm: non-interactive, auto-confirm purges

echo "### [2/8] postgres role + database (isolated)"
DBPASS_FILE=$APP/.dbpass
[ -f "$DBPASS_FILE" ] || { openssl rand -hex 24 > "$DBPASS_FILE"; chmod 600 "$DBPASS_FILE"; }
DBPASS=$(cat "$DBPASS_FILE")
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='neurion'" | grep -q 1 \
  || sudo -u postgres psql -qc "CREATE ROLE neurion LOGIN PASSWORD '$DBPASS'"
sudo -u postgres psql -qc "ALTER ROLE neurion LOGIN PASSWORD '$DBPASS'"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='neurion'" | grep -q 1 \
  || sudo -u postgres psql -qc "CREATE DATABASE neurion OWNER neurion"

echo "### [3/8] env file (secrets generated once, kept server-side 600)"
ENV=$APP/.env.production
if [ ! -f "$ENV" ]; then
  JWT_A=$(openssl rand -hex 32); JWT_R=$(openssl rand -hex 32); ADMINPW=$(openssl rand -hex 12)
  cat > "$ENV" <<EOF
NODE_ENV=production
NEURION_API_PORT=8091
NEURION_WEB_PORT=3091
DATABASE_URL=postgresql://neurion:${DBPASS}@localhost:5432/neurion
JWT_ACCESS_SECRET=${JWT_A}
JWT_REFRESH_SECRET=${JWT_R}
COOKIE_DOMAIN=neurionproject.org
AI_DEFAULT_LANE=fast
AI_ENABLE_FALLBACK=true
AI_PROVIDER_DEFAULT=openai_compatible
AI_OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1
AI_OPENAI_COMPATIBLE_API_KEY=local
AI_DEFAULT_CHAT_MODEL=qwen2.5:3b
AI_DEFAULT_SMALL_MODEL=qwen2.5:3b
AI_AGENT_MODEL=qwen2.5:3b
AGENT_FS_ENABLED=false
AGENT_REQUIRE_APPROVAL=true
SEED_ADMIN_EMAIL=admin@neurionproject.org
SEED_ADMIN_PASSWORD=${ADMINPW}
EOF
  chmod 600 "$ENV"
  echo "$ADMINPW" > "$APP/.adminpw"; chmod 600 "$APP/.adminpw"
  echo "    generated new secrets + admin password (saved to $APP/.adminpw)"
fi
set -a; . "$ENV"; set +a
# NODE_ENV stays 'production' (from the env file) so `next build` produces a
# production build. devDependencies (nest, tsx) are still installed below via
# --prod=false, which is independent of NODE_ENV.

echo "### [4/8] install api + web deps (filtered — no electron/hardhat)"
# clean any prior (possibly prod-only) trees so the install never prompts to purge
find /opt/neurion -name node_modules -type d -prune -exec rm -rf {} + 2>/dev/null || true
pnpm install --frozen-lockfile --prod=false --filter @neurion/api... --filter @neurion/web...

echo "### [5/8] prisma generate + migrate deploy"
pnpm --filter @neurion/api exec prisma generate
pnpm --filter @neurion/api exec prisma migrate deploy

echo "### [6/8] build api + web (web calls /api same-origin)"
pnpm --filter @neurion/api build
NEXT_PUBLIC_API_URL='' pnpm --filter @neurion/web build

echo "### [7/8] seed (idempotent) + systemd units"
pnpm --filter @neurion/api exec tsx prisma/seed.ts || echo "    (seed skipped/failed — non-fatal)"

cat > /etc/systemd/system/neurion-api.service <<'EOF'
[Unit]
Description=Neurion API
After=network.target postgresql.service ollama.service
[Service]
Type=simple
WorkingDirectory=/opt/neurion/apps/api
EnvironmentFile=/opt/neurion/.env.production
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/neurion-web.service <<'EOF'
[Unit]
Description=Neurion Web
After=network.target neurion-api.service
[Service]
Type=simple
WorkingDirectory=/opt/neurion/apps/web
EnvironmentFile=/opt/neurion/.env.production
Environment=PORT=3091
ExecStart=/opt/neurion/apps/web/node_modules/.bin/next start -p 3091
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable neurion-api neurion-web
systemctl restart neurion-api neurion-web   # restart (not just start) so new build + env load
sleep 4
systemctl --no-pager --lines=0 status neurion-api neurion-web || true

echo "### [8/8] nginx — add app/api proxy to the neurion vhost only"
cat > /etc/nginx/sites-available/neurionproject <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name neurionproject.org www.neurionproject.org;
    root /var/www/neurion;
    index index.html;
    add_header X-Content-Type-Options nosniff always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    client_max_body_size 25m;

    # API (SSE-safe: no buffering, long read timeout)
    location /api/ {
        proxy_pass http://127.0.0.1:8091;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
    }
    location /ws/ {
        proxy_pass http://127.0.0.1:8091;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 600s;
    }

    # static marketing landing: ONLY the root + its favicon + installer downloads
    location = /            { try_files /index.html =404; }
    location = /favicon.png { }
    location /download/     { autoindex off; }
    location /assets/       { autoindex off; }  # app-downloadable static packs (music etc.)

    # everything else is the Next.js web app (login, forgot, reset, verify,
    # app/*, _next, manifest, sw, icons …) — proxy-all so new routes just work.
    location / {
        proxy_pass http://127.0.0.1:3091;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
ln -sf /etc/nginx/sites-available/neurionproject /etc/nginx/sites-enabled/neurionproject
nginx -t && systemctl reload nginx && echo "    nginx reloaded"

# The vhost rewrite above drops certbot's SSL block — re-apply HTTPS if a cert exists.
if [ -d /etc/letsencrypt/live/neurionproject.org ]; then
  echo "    re-applying HTTPS (certbot)"
  certbot --nginx --reinstall -d neurionproject.org -d www.neurionproject.org --redirect -n >/dev/null 2>&1 || true
  systemctl reload nginx || true
fi

### [9/9] watchdog — self-heal + ntfy alert if the stack goes down (every 5 min)
chmod +x "$APP/infra/watchdog.sh" || true
cat > /etc/cron.d/neurion-watchdog <<'EOF'
*/5 * * * * root bash /opt/neurion/infra/watchdog.sh >/dev/null 2>&1
EOF
chmod 644 /etc/cron.d/neurion-watchdog
echo "    watchdog cron installed (*/5)"

echo "### DONE"
