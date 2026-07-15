# HOME ENERGY & BATTERY

HOME ENERGY & BATTERY is a local LAN tool for discovering, monitoring, and
controlling ECHONET Lite home-energy devices that are specific to my home. It uses
[`futomi/node-echonet-lite`](https://github.com/futomi/node-echonet-lite) for
UDP/LAN communication and adds a focused CLI, a small HTTP API, and a Dockerized
Web UI.

<img width="3350" height="2336" alt="image" src="https://github.com/user-attachments/assets/f8081b99-bc15-4df6-942c-9fc2f7d97b35" />

I have a Daiwa House pre-built (建売り) home which came with:

- Panasonic ホームナビゲーション
- Panasonic Enefarm
- ELIIY POWER iE5 Link
- Solar panels

I wanted a means to view and control some/all of these devices with my computer/smartphone.

This is an amateur project designed to fulfill only my own needs with my own devices, however forks/contributions are welcome.

Use this project at your own risk, you must read AND AGREE to the disclaimer at the end of this README, or in the separate DISCLAIMER file in this repository, before using this software.

## Install

Node.js 24.15 or newer is required. The application uses Node's built-in
`node:sqlite` module, so no native SQLite package or platform-specific build is
needed.

```bash
npm install --ignore-scripts
```

The `--ignore-scripts` flag avoids possible native `serialport` build failures when you
only need ECHONET Lite over LAN/IPv4. `node-echonet-lite` binds UDP port `3610`,
so stop other ECHONET clients before using this tool.

## CLI Quick Start

Replace the addresses below with known device addresses from your own LAN.

```bash
node home-energy-battery-node.js --help
node home-energy-battery-node.js discover
node home-energy-battery-node.js inspect-host --host 192.0.2.10
node home-energy-battery-node.js energy-status \
  --battery-host 192.0.2.10 \
  --solar-host 192.0.2.10 \
  --fuel-cell-host 192.0.2.30
```

The energy-status command reads:

- solar instantaneous generation: `0x027901 / 0xE0`
- battery instantaneous power: `0x027D01 / 0xD3`
- battery remaining charge: `0x027D01 / 0xE4`
- battery working status: `0x027D01 / 0xCF`
- charging profile: `0x027D01 / 0xF0`
- fuel cell instantaneous generation: `0x027C01 / 0xC4`
- fuel cell generation status: `0x027C01 / 0xCB`

## Web UI

Use the docker-compose.yml to get started easily.

Alternatively, build and run as below:

```bash
docker build -t home-energy-battery:local .
docker volume create home-energy-battery-data
docker run -d --name home-energy-battery \
  -p 8787:8787/tcp \
  -p 3610:3610/udp \
  -v home-energy-battery-data:/data \
  --env-file .env \
  home-energy-battery:local
```

Example `.env`:

```bash
TZ=Asia/Tokyo
PORT=8787
```

`TZ` is applied by the container entrypoint at startup. Device addresses are
configured from the Settings page and saved in the `home-energy-battery-data`
Docker volume.

Open:

```text
http://docker-host:8787/
```

The Web UI has live graphs, status widgets, battery profile settings,
osaifu-mode charge/discharge windows, discharge limit, direct charge/discharge
actions, schedules, device discovery, and simple historical recording.

SMTP notifications are configured from the Notifications panel in Settings and
are disabled by default. They can report Charging Demand Guard transitions,
schedule failures, device outages and recoveries, Adaptive Charging availability,
discounted charging-window shortfalls, and an optional low-SOC threshold.
Non-secret settings are stored in `/data/config.json`; the SMTP password is stored separately in
`/data/notification-secrets.json` and is never returned by the API. Delivery
cooldowns and recent results are stored in `/data/notification-state.json`.

### History storage

Telemetry, aggregates, Adaptive Charging context, automation events, and notification
delivery history are stored in `/data/history.sqlite`. On first startup after an
upgrade, existing `/data/history/samples.jsonl` and `/data/adaptive-charging/*.jsonl` files are
imported in restart-safe batches. The original files are retained as migration
backups and are no longer appended after the import.

Retention is configured in Settings. Defaults preserve raw telemetry for 1,095
days, 30-minute and daily aggregates indefinitely, Adaptive Charging and automation
history indefinitely, and notification deliveries for 365 days. Automatic
maintenance runs daily and deletes old records in small batches.

## DISCLAIMER

This software is provided "as is" without warranty of any kind, express or implied.
Use at your own risk. The author is not responsible for any damage, loss, or
injury resulting from the installation, operation, or misuse of this project.

This project is intended for personal, experimental, and non-commercial use only.
Users are responsible for complying with local laws, safety requirements, and
any terms that govern the devices and networks they connect to.

By using this software, you agree that the author and contributors are not liable
for any direct, indirect, incidental, special, or consequential damages arising
from its use.
