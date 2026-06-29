# HOME ENERGY & BATTERY

HOME ENERGY & BATTERY is a local LAN tool for discovering, monitoring, and
controlling ECHONET Lite home-energy devices that are specific to my home. It uses
[`futomi/node-echonet-lite`](https://github.com/futomi/node-echonet-lite) for
UDP/LAN communication and adds a focused CLI, a small HTTP API, and a Dockerized
Web UI.

I have a Daiwa House pre-built (建売り) home which came with:

- Panasonic ホームナビゲーション
- Panasonic Enefarm
- ELIIY POWER iE5 Link
- Solar panels

I wanted a means to view and control some/all of these devices with my computer/smartphone.

This is an amateur project designed to fulfill only my own needs with my own devices, however forks/contributions are welcome.

Use this project at your own risk, you must read AND AGREE to the disclaimer at the end of this README, or in the separate DISCLAIMER file in this repository, before using this software.

## Install

```bash
npm install --ignore-scripts
```

The `--ignore-scripts` flag avoids possible native `serialport` build failures when you
only need ECHONET Lite over LAN/IPv4. `node-echonet-lite` binds UDP port `3610`,
so stop other ECHONET clients before using this tool.

The Web UI server requires Node.js 22.5+ because history is stored with the
built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) module.

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
actions, schedules, device discovery, and historical recording. The server
samples and records device readings on the configured update interval (a
single background loop, independent of any open browser), storing them in a
SQLite database at `/data/history.db`.

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
