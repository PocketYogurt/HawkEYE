# HawkEYE

A self-hosted, real-time network edge visibility dashboard. HawkEYE sits at the boundary of your homelab or VPS and visualises incoming traffic as animated arcs on a live world map, alongside a Fail2Ban threat shield showing active bans and jail status.

Built for homelabbers who run a reverse proxy at the edge of their network and want a public-facing, GDPR-friendly showcase of what's hitting it.

---

## Features

### ⬡ Traffic Monitor
- Live world map with animated arcs showing where requests originate
- Colour-coded by HTTP status (2xx / 3xx / 4xx / 5xx)
- Real-time request feed showing country, city, method and URI
- Stats panel: total requests, unique IPs, top origin countries, RPS, uptime
- WebSocket-powered — updates instantly as traffic hits your server
- No IP addresses displayed publicly (GDPR-friendly)

### 🛡 Threat Shield
- Live Fail2Ban jail status
- Shows currently banned count, total bans, failed attempts per jail
- Auto-refreshes every 60 seconds
- No banned IPs displayed publicly (GDPR-friendly)

### Design
- Dark/light theme toggle with localStorage persistence
- Smooth fade transitions between pages
- Retro terminal aesthetic — Space Mono + Syne fonts, scanline overlay, green glow
- Fully responsive with mobile drawer layout

---

## Prerequisites

- A VPS or server running **Caddy** as a reverse proxy (native install)
- **Docker** and **Docker Compose** installed
- **Fail2Ban** installed natively (optional — Threat Shield won't work without it)
- A domain pointed at your VPS

---

## Fail2Ban Socket Setup

Before deploying, if you're using Fail2Ban, you need two one-time systemd configurations to ensure the socket is always accessible to the Docker container across reboots and Fail2Ban restarts.

**Step 1 — Fix socket permissions on every Fail2Ban start:**

```bash
sudo mkdir -p /etc/systemd/system/fail2ban.service.d
sudo nano /etc/systemd/system/fail2ban.service.d/socket-perms.conf
```

Paste:
```ini
[Service]
ExecStartPost=/bin/bash -c 'sleep 2 && chmod 666 /var/run/fail2ban/fail2ban.sock'
```

**Step 2 — Auto-recreate the HawkEYE backend when Fail2Ban restarts:**

```bash
sudo nano /etc/systemd/system/hawkeye-backend-restart.service
```

Paste (update the path if your install isn't in `/root/traffic-viz`):
```ini
[Unit]
Description=Restart HawkEYE backend after Fail2Ban restart
After=fail2ban.service

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'sleep 3 && docker compose -f /root/hawkeye/docker-compose.yml up -d --force-recreate backend'

[Install]
WantedBy=fail2ban.service
```

**Step 3 — Apply:**
```bash
sudo systemctl daemon-reload
sudo systemctl enable hawkeye-backend-restart.service
sudo systemctl restart fail2ban
```

Every time Fail2Ban restarts, the socket permissions are automatically fixed and the backend container is recreated with the fresh socket — no manual intervention needed.

---

## Installation

### 1. Enable Caddy JSON Logging

Add to the top of your Caddyfile (global options block):

```caddy
{
    log {
        output file /var/log/caddy/access.log {
            roll_size 100mb
            roll_keep 5
            roll_keep_for 720h
        }
        format json
    }
}
```

Reload Caddy:
```bash
sudo systemctl reload caddy
```

### 2. Clone the repo

```bash
git clone https://github.com/YOUR_USERNAME/hawkeye.git
cd hawkeye
```

### 3. Configure

Edit `docker-compose.yml` and set your server's coordinates and display name:

```yaml
environment:
  SERVER_LAT: 51.5074       # Your server latitude
  SERVER_LON: -0.1278       # Your server longitude
  SERVER_CITY: "My Server"  # Display name on the map
```

Find your coordinates at [latlong.net](https://www.latlong.net).

### 4. Deploy

```bash
docker compose up -d --build
```

### 5. Configure Caddy to proxy HawkEYE

Add to your Caddyfile:

```caddy
traffic.yourdomain.com {
    reverse_proxy localhost:8080
}
```

Reload Caddy:
```bash
sudo systemctl reload caddy
```

Visit `https://traffic.yourdomain.com` — you should see the live map.

---

## Fail2Ban Integration

The Threat Shield page requires Fail2Ban to be installed natively on the host. The socket is mounted into the Docker container.

The socket path varies by distro. Check yours:
```bash
ls /var/run/fail2ban/fail2ban.sock
# or
ls /run/fail2ban/fail2ban.sock
```

Update `docker-compose.yml` to match:
```yaml
volumes:
  - /var/run/fail2ban/fail2ban.sock:/run/fail2ban/fail2ban.sock
```

If Fail2Ban is not installed, the Threat Shield page will show an error — the Traffic Monitor will still work fine.

---

## Caddy Log Filtering

If you want to exclude certain subdomains from appearing in HawkEYE (e.g. internal tools, Jellyfin), add `log { output discard }` to those Caddy blocks:

```caddy
jellyfin.yourdomain.com {
    log {
        output discard
    }
    reverse_proxy 10.0.0.2:8096
}
```

---

## GDPR Mode

HawkEYE has a built-in `GDPR_MODE` flag controlled via `docker-compose.yml`. This lets you toggle IP visibility without touching any code.

```yaml
environment:
  GDPR_MODE: "true"   # IPs hidden — safe for public deployments (default)
  GDPR_MODE: "false"  # IPs visible — full detail for private/internal use
```

**When `GDPR_MODE=true` (default):**
- No IP addresses shown in the live request feed
- No IP shown in map marker tooltips
- Fail2Ban Threat Shield shows ban counts only — no banned IPs listed

**When `GDPR_MODE=false`:**
- Full IP addresses shown in the live request feed
- IP shown in map marker tooltips
- Full banned IP list shown per jail on the Threat Shield page

The mode is read from the backend at runtime and applied to both pages automatically — no frontend changes needed when switching.

After changing `GDPR_MODE`, restart the backend to apply:

```bash
docker compose up -d --force-recreate backend
```

---

## Additional GDPR Considerations

For a fully privacy-respecting public deployment, also consider:

- **IP masking in Caddy logs** — truncates IPs at source so they're never stored in full:

```caddy
log {
    format filter {
        wrap json
        fields {
            request>remote_ip ip_mask {
                ipv4 /24
                ipv6 /48
            }
        }
    }
}
```

- **Log retention** — already partially configured with `roll_keep 5`, add `roll_keep_for 720h` to cap storage at 30 days
- **Access control** — add `basicauth` in Caddy if you want to restrict who can view the dashboard

---

## File Structure

```
hawkeye/
├── backend/
│   ├── Dockerfile          # Node.js 20 Alpine + fail2ban-client
│   ├── package.json
│   └── server.js           # Express + WebSocket server, log tailer, GeoIP
├── frontend/
│   ├── index.html          # Traffic Monitor (MapLibre GL map + live feed)
│   └── fail2ban.html       # Threat Shield (Fail2Ban jail status)
├── nginx.conf              # Nginx reverse proxy config for frontend → backend
├── docker-compose.yml      # Two services: backend + frontend (nginx)
└── README.md
```

---

## Tech Stack

| Component | Technology |
|---|---|
| Backend | Node.js, Express, ws, chokidar, geoip-lite |
| Frontend | Vanilla JS, MapLibre GL, Space Mono + Syne (Google Fonts) |
| Map tiles | CartoCDN (dark/light) |
| Container | Docker Compose (Node 20 Alpine + nginx:alpine) |
| Reverse proxy | Caddy (native, not containerised) |
| Intrusion detection | Fail2Ban (native, socket-mounted) |

---

## Licence

MIT — do whatever you want with it.
