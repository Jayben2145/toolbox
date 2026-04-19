# Shared Pad & Tools

Collaborative Node.js workspace with a realtime shared pad, lightweight tools hub, and a PDF → JPG converter. Built with Express, Socket.IO, Pug, and Docker-friendly defaults.

> ⚠️ No built-in authentication. Run behind a reverse proxy (HTTP auth, VPN, SSO) or on a trusted network only.

## Pages & what they need

| Page | URL | Works out of the box? |
|---|---|---|
| Tools hub | `/` | Yes |
| Shared pad | `/pad` → `/pad/:room` | Yes |
| PDF → JPG | `/tools/pdf-to-jpg` | Yes (poppler is bundled in the Docker image) |
| Diagram workspace | `/tools/draw` | No — requires a running draw.io instance (see below) |

---

## Docker setup (recommended)

### 1. Install Docker & Compose

```bash
# Ubuntu/Debian
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update && sudo apt-get install -y docker-ce docker-compose-plugin
```

Verify: `docker compose version`

### 2. Build the image

```bash
git clone https://github.com/Jayben2145/toolbox.git shared-pad
cd shared-pad
docker build -t shared-pad .
```

### 3. Start the app

```bash
docker compose up -d
```

The app is now at `http://localhost:9550`. Pad data persists in the `sharedpad-data` Docker volume.

The Tools hub, Shared Pad, and PDF → JPG pages all work at this point. Continue to step 4 to enable the Diagram Workspace.

---

## Enabling the Diagram Workspace (draw.io)

The `/tools/draw` page renders an `<iframe>` pointing at a draw.io editor. Because the iframe loads in the **user's browser** (not on the server), draw.io must be reachable from the browser — not just from inside Docker.

### Option A — draw.io on its own port (simplest)

Replace `docker-compose.yml` with the version below. It runs draw.io as a sidecar and exposes it on port 8080 so the browser can reach it.

```yaml
services:
  shared-pad:
    build: .
    image: shared-pad:latest
    container_name: shared-pad
    environment:
      - NODE_ENV=production
      - PORT=3000
      # Must be a URL the browser can reach — use your server's IP or hostname if not localhost
      - DRAW_IO_URL=http://localhost:8080/?embed=1&ui=atlas&spin=1&proto=json
    ports:
      - "9550:3000"
    volumes:
      - sharedpad-data:/usr/src/app/data
    restart: unless-stopped
    depends_on:
      - drawio

  drawio:
    image: jgraph/drawio
    container_name: drawio
    ports:
      - "8080:8080"
    restart: unless-stopped

volumes:
  sharedpad-data:
```

```bash
docker compose up -d
```

- Tools app: `http://localhost:9550`
- Diagram Workspace: `http://localhost:9550/tools/draw`
- draw.io standalone: `http://localhost:8080`

> If the server is not `localhost` from the browser's perspective, replace `localhost` in `DRAW_IO_URL` with the server's IP or hostname.

### Option B — reverse proxy on the same origin (HTTPS / production)

Proxy draw.io at a sub-path so it shares the same origin as the app. This is required when running over HTTPS to avoid mixed-content errors.

Example nginx config (both services behind nginx):

```nginx
server {
    listen 443 ssl;
    server_name tools.example.com;

    # shared-pad app
    location / {
        proxy_pass http://shared-pad:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # WebSocket support (required for pad sync)
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # draw.io embedded at /drawio/
    location /drawio/ {
        proxy_pass http://drawio:8080/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Set `DRAW_IO_URL` to the relative path:

```
DRAW_IO_URL=/drawio/?embed=1&ui=atlas&spin=1&proto=json
```

Because the URL is relative, the browser loads it from the same origin — no CORS or mixed-content issues.

---

## Plain Docker (no Compose)

```bash
docker build -t shared-pad .
docker run -d \
  --name shared-pad \
  -e NODE_ENV=production \
  -e DRAW_IO_URL=http://localhost:8080/?embed=1&ui=atlas&spin=1&proto=json \
  -p 9550:3000 \
  -v sharedpad-data:/usr/src/app/data \
  shared-pad
```

---

## Local development (no Docker)

### Prerequisites

- Node.js 18+ (20 recommended)
- `poppler-utils` for PDF → JPG:
  - Ubuntu/Debian: `sudo apt-get install -y poppler-utils`
  - macOS: `brew install poppler`
  - Alpine: `apk add poppler-utils`
  - Fedora: `dnf install poppler-utils`

```bash
npm install
npm start        # production
npm run dev      # nodemon (auto-restart on changes)
```

Visit `http://localhost:3000`.

---

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | Port the server listens on inside the container | `3000` |
| `DRAW_IO_URL` | Full URL or same-origin path for the embedded draw.io editor | `http://127.0.0.1:8080/?embed=1&ui=atlas&spin=1&proto=json` |

---

## Storage layout

All runtime data lives under `data/` (mounted as a Docker volume):

| Path | Contents |
|---|---|
| `data/pads/` | Persisted pad JSON, one file per room key |
| `data/files/<room>/` | Files uploaded to a pad room |
| `data/uploads/` | Temporary PDF uploads (auto-cleaned after conversion) |
| `data/outputs/` | Temporary JPG outputs (auto-cleaned after download) |

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
| `GET` | `/tools/draw` | Embedded draw.io workspace |
| `GET` | `/tools/pdf-to-jpg` | PDF → JPG conversion form |
| `POST` | `/tools/pdf-to-jpg` | Run PDF → JPG conversion |
| `GET` | `/health` | Health check — `{ ok: true }` |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| **`docker compose` not found** | Install the Compose plugin: `sudo apt-get install docker-compose-plugin` |
| **Port conflict (EADDRINUSE)** | Change the host port in `docker-compose.yml`, e.g. `9551:3000` |
| **`spawn pdftoppm ENOENT`** | Rebuild the Docker image; or install `poppler-utils` locally |
| **Diagram page blank / iframe blocked** | `DRAW_IO_URL` must be reachable from the browser. Use a host port or reverse-proxy draw.io to the same origin |
| **Pads not syncing** | Ensure your reverse proxy forwards WebSocket upgrade headers (see nginx example above) |
| **Invalid pad key** | Keys allow only `a–z A–Z 0–9 - _` up to 64 characters |

---

## License

MIT
