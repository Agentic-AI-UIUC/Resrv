# Deployment Guide

## Server Details
- **Host:** 178.105.104.34 (Hetzner CAX11, Ubuntu 24.04 ARM64)
- **SSH key:** `~/.ssh/hetzner_reserv`
- **App path:** `/opt/reserv`
- **Venv:** `/opt/reserv/.venv`
- **Service:** `reserv.service` (systemd, auto-restart)
- **Watchdog cron:** every 2 min, re-posts missing Discord embeds
- **Watchdog log:** `/var/log/reserv-watchdog.log`

## Quick Deploy

```bash
# 1. Build frontend
cd web && npm run build && cd ..

# 2. Rsync to server (excludes .git, node_modules, tests, DB, secrets)
rsync -avz \
  --exclude='.git' --exclude='node_modules' --exclude='__pycache__' \
  --exclude='.venv' --exclude='venv' --exclude='*.pyc' \
  --exclude='.claude' --exclude='CLAUDE.md' --exclude='learnings.md' \
  --exclude='short_term_memory.md' --exclude='long_term_memory.md' \
  --exclude='tests' --exclude='*.db' \
  -e "ssh -i ~/.ssh/hetzner_reserv" \
  ./ root@178.105.104.34:/opt/reserv/

# 3. Restart service
ssh -i ~/.ssh/hetzner_reserv root@178.105.104.34 "systemctl restart reserv"
```

## One-Liner

```bash
cd web && npm run build && cd .. && rsync -avz --exclude='.git' --exclude='node_modules' --exclude='__pycache__' --exclude='.venv' --exclude='venv' --exclude='*.pyc' --exclude='.claude' --exclude='CLAUDE.md' --exclude='learnings.md' --exclude='short_term_memory.md' --exclude='long_term_memory.md' --exclude='tests' --exclude='*.db' -e "ssh -i ~/.ssh/hetzner_reserv" ./ root@178.105.104.34:/opt/reserv/ && ssh -i ~/.ssh/hetzner_reserv root@178.105.104.34 "systemctl restart reserv"
```

## Useful Commands

```bash
# SSH into server
ssh -i ~/.ssh/hetzner_reserv root@178.105.104.34

# Check service status
ssh -i ~/.ssh/hetzner_reserv root@178.105.104.34 "systemctl status reserv --no-pager -l"

# View logs
ssh -i ~/.ssh/hetzner_reserv root@178.105.104.34 "journalctl -u reserv --no-pager -n 50"

# View watchdog log
ssh -i ~/.ssh/hetzner_reserv root@178.105.104.34 "tail -20 /var/log/reserv-watchdog.log"

# Restart
ssh -i ~/.ssh/hetzner_reserv root@178.105.104.34 "systemctl restart reserv"

# Run watchdog manually
ssh -i ~/.ssh/hetzner_reserv root@178.105.104.34 "cd /opt/reserv && .venv/bin/python3 watchdog.py"
```

## Architecture

- `main.py` starts both FastAPI (port 8000, background thread) and Discord bot (main loop)
- FastAPI serves the API at `/api/*` and the built frontend SPA at `/`
- Frontend build output: `web/dist/` (mounted as static files by FastAPI)
- SQLite DB: `reserv.db` (on the server, not synced)
- `.env` lives on the server at `/opt/reserv/.env` (not synced)
- Discord queue channel: `reserv-machines` (ID: 1501339241555165264)
- Discord admin channel: ID 1501303889075638504

## Notes

- The `.env` on the server is separate from local. If you add new env vars, update both.
- The `reserv.db` on the server persists across deploys (rsync excludes `*.db`).
- Watchdog cron runs every 2 min to re-post any Discord embeds that go missing.
- The `_seed_machines` in `db/database.py` seeds: Printer, Laser Cutter, CNC Router, Water Jet.
