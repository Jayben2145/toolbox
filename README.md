# Shared Pad & Tools

A small self-hosted toolbox: a realtime shared text pad, a text compare (diff) tool, a PDF → JPG converter and an embedded draw.io diagram editor. It is built with Node.js (Express, Socket.IO, Pug) and runs in Docker behind an nginx reverse proxy.

> ⚠️ **The app has no authentication of its own.** Put it behind a reverse proxy that handles auth (HTTP basic auth, SSO, VPN), or run it only on a trusted network.

## Contents

1. [Tools](#tools)
2. [How it all fits together](#how-it-all-fits-together)
3. [Project layout](#project-layout)
4. [Run and test locally in code-server (before deploying)](#run-and-test-locally-in-code-server-before-deploying)
5. [Deploy with Docker](#deploy-with-docker)
6. [Set up the draw.io container](#set-up-the-drawio-container)
7. [Put it behind nginx](#put-it-behind-nginx)
8. [Configuration](#configuration)
9. [Storage, routes and troubleshooting](#storage-layout)

---

## Tools

| Tool | URL | Needs |
|---|---|---|
| Tools hub | `/` | Nothing extra |
| Shared Pad | `/pad` → `/pad/:room` | Nothing extra (WebSockets must pass through the proxy) |
| Compare | `/tools/compare` | Nothing extra. Runs entirely in the browser |
| PDF → JPG | `/tools/pdf-to-jpg` | `pdftoppm` from poppler (included in the Docker image) |
| Diagram Workspace | `/tools/draw` | A running draw.io container that the **browser** can reach |

### Compare

Paste the original text into the left box (**Base**) and the text to check into the right box (**Compared**), then press **Compare** (or `Ctrl+Enter`). The result appears below as a side-by-side, line-by-line view:

| Colour | Meaning |
|---|---|
| 🔴 Red | The line is in the base but missing from the compared text (removed) |
| 🔵 Blue | The line exists on both sides but was edited. The words that changed are highlighted more strongly |
| 🟢 Green | The line exists only in the compared text (added) |

Options:

- **Ignore leading/trailing whitespace** and **Ignore case** treat lines as equal when they differ only in those ways.
- **Only show differences** collapses unchanged lines, keeping 3 lines of context around each change.
- **Swap** exchanges the two sides.
- **Copy as text** copies the result with each line prefixed: `-` removed, `+` added, `~` edited.

Nothing is uploaded: the diff runs in your browser (`public/compare.js`).

---

## How it all fits together

```
                       Browser
                          │  https://tools.example.com
                          ▼
              ┌───────────────────────────┐
              │  nginx (TLS + auth)       │
              └───────────────────────────┘
                 │ /                   │ /drawio/
                 ▼                     ▼
        ┌─────────────────┐    ┌─────────────────┐
        │ shared-pad      │    │ drawio          │
        │ Node app :3000  │    │ jgraph/drawio   │
        │ (this repo)     │    │ :8080           │
        └─────────────────┘    └─────────────────┘
                 │
        sharedpad-data volume  (pads, uploaded files)
```

- **shared-pad** is this repo, built into a Docker image. It serves every page, the Socket.IO WebSocket used by the pad, and the PDF conversion.
- **drawio** is the official `jgraph/drawio` image, run unmodified.
- **nginx** terminates HTTPS, asks for a login, and routes `/drawio/` to the draw.io container and everything else to shared-pad.

The two containers never talk to each other. `/tools/draw` is a page containing an `<iframe src="DRAW_IO_URL">`, and the **user's browser** loads that URL. That is why `DRAW_IO_URL` must be a URL the browser can reach. Serving draw.io under `/drawio/` on the same domain is the cleanest option: there is one hostname and one certificate, the login covers both, and you avoid mixed-content errors.

---

## Project layout

| Path | What it is |
|---|---|
| `server.js` | Express app: routes, uploads, PDF conversion, Socket.IO pad sync |
| `views/*.pug` | Page templates (`layout.pug` wraps all pages) |
| `views/tool_compare.pug` | Compare tool page |
| `public/style.css` | All styles |
| `public/client.js` | Shared Pad browser logic (sync, live file list) |
| `public/compare.js` | Compare tool diff engine and UI |
| `dockerfile` | Production image (Node 20 Alpine + poppler) |
| `docker-compose.yml` | Runs `shared-pad` and `drawio` together |
| `.env.example` | Template for the `.env` file Compose reads |
| `data/` | Runtime data (git-ignored, a Docker volume in production) |

---

## Run and test locally in code-server (before deploying)

These steps are for running the site inside the **linuxserver.io code-server** container used for development (Ubuntu, user `abc`, home `/config`). They also work on any Linux machine. On a plain machine, ignore the code-server notes and open `http://localhost:3000`.

### 1. Install Node.js 20 (one time)

The code-server image does not include Node. Install it with **nvm**. nvm lives under `/config`, the persistent volume, so it survives container updates:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 20
node -v    # v20.x
```

> code-server terminals read `~/.bashrc`, not `~/.profile`. If `node` is missing in a new terminal, check where the nvm installer wrote its loader lines. If they only went into `~/.profile`, add them to `~/.bashrc` too:
>
> ```bash
> export NVM_DIR="$HOME/.nvm"
> [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
> ```

> Alternatively, add `DOCKER_MODS=linuxserver/mods:code-server-nodejs` to the code-server container's environment and recreate it. See that mod's README for how to choose the Node version.

### 2. Install poppler (only needed for PDF → JPG)

```bash
sudo apt-get update && sudo apt-get install -y poppler-utils
```

Packages installed with `apt` are lost when the code-server container is recreated. To make poppler permanent, add these to the code-server container's environment:

```yaml
- DOCKER_MODS=linuxserver/mods:universal-package-install
- INSTALL_PACKAGES=poppler-utils
```

(If you already use `DOCKER_MODS`, separate the mods with `|`.)

### 3. Install dependencies and start the dev server

```bash
cd /config/workspace/Webpages/tools/toolbox
npm install
npm run dev          # nodemon, restarts when server.js changes
```

The terminal prints `Tools + Shared Pad running on http://localhost:3000`. To use another port, run `PORT=3001 npm run dev`.

- Edits to `public/*.css` and `public/*.js` show up when you refresh the browser.
- Edits to `views/*.pug` also show up on refresh, because dev mode does not cache templates.
- Edits to `server.js` restart the server automatically.

**Diagram Workspace while developing:** there is usually no draw.io container in the dev environment. Point the iframe at your deployed draw.io or at the public hosted editor:

```bash
DRAW_IO_URL='https://embed.diagrams.net/?embed=1&ui=atlas&spin=1&proto=json' npm run dev
```

### 4. Open the site from your browser

The server runs inside the code-server container, so your browser needs a route to port 3000. Pick one:

| Method | URL | Notes |
|---|---|---|
| **Path proxy** (zero setup) | `https://<your-code-server-url>/proxy/3000/` (note the trailing slash) | Works out of the box and is protected by code-server's login. The hub, **Compare**, PDF → JPG and Diagram pages all work. The **Shared Pad's room pages do not** work here, because the server's redirects and the pad's upload/delete forms still use absolute `/pad/...` URLs. Test the pad with one of the options below. |
| **Subdomain proxy** | `https://3000.<your-code-server-domain>/` | Everything works. Needs `PROXY_DOMAIN` set on the code-server container, plus a wildcard DNS record and a wildcard proxy entry/certificate for `*.<domain>`. If `PROXY_DOMAIN` is still the example value `code-server.my.domain`, this will not resolve until you set it up. |
| **Publish the port** | `http://<docker-host>:3000/` | Everything works. Add `- 3000:3000` to the code-server container's `ports:` and recreate it. Simple, but has **no auth**, so only use it on a trusted LAN. |

Quick check from the code-server terminal:

```bash
curl -s localhost:3000/health     # {"ok":true,"pads":0}
```

### 5. Pre-deploy checklist

Click through these before pushing a change to the server:

- [ ] `/` shows every tool card.
- [ ] **Shared Pad**: open the same key in two tabs. Typing in one appears in the other, and the counter shows "2 online".
- [ ] **Shared Pad files**: an upload appears in both tabs, and download and delete work.
- [ ] **Compare**: removed, edited and added lines show red, blue and green. Swap, Clear and "Only show differences" work.
- [ ] **PDF → JPG**: a one-page PDF downloads a `.jpg`, and a multi-page PDF downloads `pages.zip`.
- [ ] **Diagram Workspace**: the draw.io editor loads in the frame.
- [ ] The browser dev tools console (F12) shows no errors.

Local runtime data goes in `./data/`, which is git-ignored. Delete it whenever you want a clean slate.

> **Optional: build the Docker image from code-server.** code-server has no Docker by default. Adding `DOCKER_MODS=linuxserver/mods:universal-docker` and mounting `/var/run/docker.sock` into the code-server container lets you run `docker build` and `docker compose` from its terminal. This gives the code-server container root-level control of the host, so only do it on a machine you trust.

---

## Deploy with Docker

On the server that will host the site:

### 1. Install Docker and the Compose plugin

```bash
# Ubuntu/Debian
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update && sudo apt-get install -y docker-ce docker-compose-plugin
docker compose version
```

### 2. Get the code and configure it

```bash
git clone https://github.com/Jayben2145/toolbox.git
cd toolbox
cp .env.example .env
nano .env            # see the draw.io and nginx sections below for the right values
```

### 3. Build and start

```bash
docker compose up -d --build
docker compose ps                      # both containers should be "running"/"healthy"
curl -s localhost:9550/health          # {"ok":true,...}
```

This starts two containers:

- `shared-pad` (this app) on host port **9550**
- `drawio` on host port **8080**

### Updating to a new version

```bash
cd toolbox
git pull
docker compose up -d --build           # rebuilds shared-pad, keeps data
docker compose pull drawio && docker compose up -d drawio   # update draw.io
docker image prune -f                  # optional: remove old image layers
```

### Logs, backups

```bash
docker compose logs -f shared-pad

# back up pads and uploaded files
docker run --rm -v toolbox_sharedpad-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/sharedpad-data-$(date +%F).tgz -C /data .
```

(Compose prefixes the volume name with the project folder name. Run `docker volume ls` to see the exact name.)

---

## Set up the draw.io container

`docker-compose.yml` already includes draw.io:

```yaml
  drawio:
    image: jgraph/drawio:latest
    container_name: drawio
    ports:
      - "${DRAWIO_PORT:-8080}:8080"
    restart: unless-stopped
```

It is the stock diagrams.net editor and needs no configuration. You can open it on its own at `http://<server>:8080/`.

Next, tell the app where the **browser** should load draw.io from by setting `DRAW_IO_URL` in `.env`:

| Setup | `DRAW_IO_URL` |
|---|---|
| Behind nginx at `/drawio/` (recommended) | `/drawio/?embed=1&ui=atlas&spin=1&proto=json` |
| No proxy, direct port | `http://<server-ip-or-name>:8080/?embed=1&ui=atlas&spin=1&proto=json` |

Then run `docker compose up -d` to apply the change. A relative value like `/drawio/...` makes the browser use the same domain as the app.

The query string sets the editor mode: `embed=1` is embedded mode, `ui=atlas` is the theme, and `spin=1` shows a loading spinner.

### draw.io without Compose

```bash
docker run -d --name drawio --restart unless-stopped -p 8080:8080 jgraph/drawio:latest
```

---

## Put it behind nginx

### Lock the containers to localhost first

If nginx runs on the **same host**, stop the containers being reachable directly, so nobody can bypass the login. Put this in `.env`:

```bash
APP_PORT=127.0.0.1:9550
DRAWIO_PORT=127.0.0.1:8080
DRAW_IO_URL=/drawio/?embed=1&ui=atlas&spin=1&proto=json
```

Then run `docker compose up -d`.

### Create a login

```bash
sudo apt-get install -y nginx apache2-utils
sudo htpasswd -c /etc/nginx/.htpasswd yourname      # -c only for the first user
```

### Site config

Save this as `/etc/nginx/conf.d/tools.conf`, changing the domain and certificate paths:

```nginx
# Lets Socket.IO upgrade to WebSockets
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name tools.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name tools.example.com;

    ssl_certificate     /etc/letsencrypt/live/tools.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tools.example.com/privkey.pem;

    # Pad uploads allow up to 50 MB (nginx's default limit is only 1 MB)
    client_max_body_size 50m;

    # The app has no login of its own. This protects every path, including /drawio/
    auth_basic           "Tools";
    auth_basic_user_file /etc/nginx/.htpasswd;

    # --- the app (pages, uploads, Socket.IO) ---
    location / {
        proxy_pass http://127.0.0.1:9550;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # WebSocket upgrade, needed for pad sync
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;
    }

    # --- draw.io, served on the same domain under /drawio/ ---
    location = /drawio { return 301 /drawio/; }
    location /drawio/ {
        # The trailing slash strips the /drawio prefix before forwarding
        proxy_pass http://127.0.0.1:8080/;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Get a certificate with certbot (`sudo certbot --nginx -d tools.example.com`) or use your own. Then open `https://tools.example.com`, log in, and run through the [pre-deploy checklist](#5-pre-deploy-checklist) again on the live site.

### If nginx runs in Docker

Put nginx on the same Docker network as the two containers. Then use container names instead of `127.0.0.1` and drop the host `ports:` mappings entirely:

```nginx
proxy_pass http://shared-pad:3000;     # location /
proxy_pass http://drawio:8080/;        # location /drawio/
```

### Nginx Proxy Manager

- Create a **Proxy Host** for your domain that forwards to `<host>:9550`, and turn on **Websockets Support**.
- On the **SSL** tab, request a certificate and enable *Force SSL*.
- On the **Advanced** tab, add the `/drawio/` route and the upload limit:

  ```nginx
  client_max_body_size 50m;
  location /drawio/ {
      proxy_pass http://<host>:8080/;
      proxy_set_header Host $host;
  }
  ```

- Add an **Access List** with a username and password, and attach it to the proxy host.

---

## Configuration

Environment variables for the app container. With Compose, set them in `.env`.

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | Port the Node server listens on (inside the container) | `3000` |
| `DRAW_IO_URL` | URL or same-origin path the browser loads into the draw.io iframe | `http://localhost:8080/?embed=1&ui=atlas&spin=1&proto=json` (Compose) |
| `APP_PORT` | Host port binding for shared-pad (Compose only) | `9550` |
| `DRAWIO_PORT` | Host port binding for draw.io (Compose only) | `8080` |

The app trusts one proxy hop (`app.set('trust proxy', 1)` in `server.js`). Raise this if more than one proxy sits in front of it.

---

## Storage layout

All runtime data lives under `data/`, which is the `sharedpad-data` Docker volume in production:

| Path | Contents |
|---|---|
| `data/pads/` | Saved pad text as JSON, one file per room key |
| `data/files/<room>/` | Files uploaded to a pad room |
| `data/uploads/` | Temporary PDF uploads, deleted after conversion |
| `data/outputs/` | Temporary JPG outputs, deleted after download |

---

## Routes

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Tools hub |
| `GET` | `/pad` | Enter or generate a pad key |
| `GET` | `/pad/:room` | Shared pad for a room |
| `GET` | `/pad/:room/files.json` | JSON file list for a room |
| `POST` | `/pad/:room/files` | Upload a file to a pad room |
| `GET` | `/pad/:room/files/:file` | Download a file from a pad room |
| `POST` | `/pad/:room/files/:file/delete` | Delete a file from a pad room |
| `GET` | `/tools/compare` | Text compare (diff runs client-side) |
| `GET` | `/tools/draw` | Embedded draw.io workspace |
| `GET` | `/tools/pdf-to-jpg` | PDF → JPG conversion form |
| `POST` | `/tools/pdf-to-jpg` | Run PDF → JPG conversion |
| `GET` | `/health` | Health check: `{ ok: true }` |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| **`node: command not found`** in code-server | Install Node with nvm (see [local setup](#1-install-nodejs-20-one-time)), then open a new terminal or run `source ~/.bashrc` |
| **`docker compose` not found** | `sudo apt-get install docker-compose-plugin` |
| **Port conflict (EADDRINUSE)** | Locally: `PORT=3001 npm run dev`. In Docker: change `APP_PORT` in `.env` |
| **`spawn pdftoppm ENOENT`** / "Converter not available" | Install `poppler-utils` locally, or rebuild the Docker image |
| **Pad room page 404s under code-server `/proxy/3000/`** | Known limitation: pad redirects and forms use absolute paths. Use the subdomain proxy or a published port to test the pad |
| **No styling under `/proxy/3000`** | Add the trailing slash: `/proxy/3000/`. Links are page-relative |
| **Diagram page blank / "refused to connect"** | The browser cannot reach `DRAW_IO_URL`. Open that URL directly in a browser tab to test it. Behind nginx, use `/drawio/...` with the trailing slash |
| **Mixed content error on `/tools/draw`** | The site is HTTPS but `DRAW_IO_URL` is `http://...`. Serve draw.io through nginx at `/drawio/` |
| **Pad stuck on "Syncing…" or not syncing** | The proxy is not forwarding WebSocket upgrades. Check the `Upgrade`/`Connection` headers in the nginx config, or *Websockets Support* in NPM |
| **Upload fails with 413 Request Entity Too Large** | Add `client_max_body_size 50m;` to the nginx server block |
| **Invalid pad key** | Keys allow only `a–z A–Z 0–9 - _`, up to 64 characters |

---

## License

MIT
