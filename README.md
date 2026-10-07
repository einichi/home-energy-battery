# HOME ENERGY & BATTERY

HOME ENERGY & BATTERY is a local LAN tool for discovering, monitoring, and
controlling ECHONET Lite home-energy devices that are specific to my home. It uses
[`futomi/node-echonet-lite`](https://github.com/futomi/node-echonet-lite) for
UDP/LAN communication directly through the web application and provides a
Dockerized React UI.

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

## ECHONET integration

The TypeScript web server talks to ECHONET Lite devices directly through
`lib/echonet-service.ts`. It keeps one UDP client open and serializes reads,
writes, and discovery through a priority queue, so frequent dashboard refreshes
do not launch extra Node processes or repeatedly compete for UDP port `3610`.
Device commands and scheduled automation use this same in-process service.

For a local production-style run, compile the backend and UI before starting
the emitted server:

```bash
npm run build:server
npm run build:ui
npm start
```

Production runs `dist/server.js`; backend TypeScript sources are not interpreted
at runtime.

The integrated status service reads:

- solar instantaneous generation: `0x027901 / 0xE0`
- battery instantaneous power: `0x027D01 / 0xD3`
- battery remaining charge: `0x027D01 / 0xE4`
- battery working status: `0x027D01 / 0xCF`
- charging profile: `0x027D01 / 0xF0`
- fuel cell instantaneous generation: `0x027C01 / 0xC4`
- fuel cell generation status: `0x027C01 / 0xCB`
- fuel cell hot-water level: `0x027C01 / 0xF4` (vendor EPC — this Panasonic
  Ene-Farm does not implement the ECHONET standard remaining-hot-water property
  `0xE1`, which returns `Get_SNA`; see the note on `FUEL_CELL_HOT_WATER_LEVEL` in
  `lib/adapters/echonet-codecs.ts`)

## Web UI

The HTTP service is intentionally unauthenticated and intended only for a trusted
local network. Access it with an IPv4 or bracketed IPv6 literal, `localhost`, a
single-label LAN hostname, or a name below `.local`, `.home.arpa`, or `.internal`.
Publicly delegated FQDNs are rejected by an exact-name Host allowlist as a
DNS-rebinding defense, even if they currently resolve to a private address.

### HTTPS and a trusted hostname

You can opt in to a normal domain (for example `hems.example.com`) that resolves
to a LAN address and obtain a publicly trusted certificate from Let's Encrypt.
This does **not** expose the app to the internet: the domain is simply accepted
as the exact Host for the bundled Caddy TLS terminator, while every other public
name stays rejected.

The Docker image bundles Caddy with DNS-01 providers for **Cloudflare** and
**Route53**, so the certificate is issued without any inbound access. Configure
it under **System → HTTPS**:

1. Open System → HTTPS over the existing LAN access (an IP address is fine).
2. Enter the trusted hostname, the DNS provider, its API credentials, and an
   ACME email address, then save. Credentials are stored `0600` in
   `tls-secrets.json` and are never returned by the API.
3. Caddy obtains the certificate and serves HTTPS on `HTTPS_PORT` (default 443).
   The name is added to the app's Host allowlist at the same time.

Requests from non-private client addresses are rejected at both Caddy and the
app, as a guard against accidentally exposing the port. Because this guard is
address-based, clients that reach the app from a globally routable address
(including public IPv6) are rejected; use a LAN IPv4 or ULA address. The
plain-HTTP site is kept up until a trusted certificate exists; the **Keep
non-TLS HTTP access** option retains it as a lockout fallback and shows a warning
while both are active. No `PUBLIC_*` env var is required.

Relevant environment variables:

- `HTTP_PORT` (default `PORT`, 8787): Caddy's plain-HTTP port
- `HTTPS_PORT` (default 443): Caddy's TLS port
- `HOST` (default `0.0.0.0`; the image sets `127.0.0.1`): app bind address. When
  loopback, the app listens on an internal ephemeral port behind Caddy.

Do not weaken the Host allowlist or bind the app directly to a public interface.

Use the docker-compose.yml to get started easily.

Alternatively, build and run as below:

```bash
docker build -t home-energy-battery:local .
docker volume create home-energy-battery-data
docker run -d --name home-energy-battery \
  -p 8787:8787/tcp \
  -p 443:443/tcp \
  -p 3610:3610/udp \
  -v home-energy-battery-data:/data \
  --env-file .env \
  home-energy-battery:local
```

Example `.env`:

```bash
TZ=Asia/Tokyo
PORT=8787
# HTTPS port served by the bundled Caddy for the trusted hostname
HTTPS_PORT=443
# Optional request timeout for the in-process ECHONET client
ECHONET_TIMEOUT_MS=15000
# Optional LAN interface address when automatic selection is unsuitable
# ECHONET_NETIF=10.0.0.20
```

`TZ` is applied by the container entrypoint at startup. Device addresses are
configured from System and saved in the `home-energy-battery-data`
Docker volume.

Open:

```text
http://docker-host:8787/
```

The Web UI has live graphs, status widgets, battery profile settings,
osaifu-mode charge/discharge windows, discharge limit, direct charge/discharge
actions, schedules, device discovery, and simple historical recording.

### UI development (simulator only)

The React UI is the sole application interface. It includes a today-focused Overview,
historical Reports, verified Battery controls and schedules, Disaster Prep, Automation,
and routed System administration in English and Japanese. Start its
development environment with:

```bash
npm run dev:ui
```

This is the only supported command for UI development. It creates a temporary
data directory, forces the device simulator, disables external I/O, and starts:

- React/Vite UI: `http://127.0.0.1:5173/ui/`
- simulated API: `http://127.0.0.1:8797/`

The UI displays a persistent simulated-environment banner. The launcher refuses
the production API port, a real device adapter, a non-temporary data directory,
or enabled external I/O. Do not point Vite at the household instance or copy
production addresses, databases, credentials, or notification recipients into
development fixtures.

Run the frontend quality gates with:

```bash
npm run typecheck:ui
npm run lint:ui
npm run test:ui
npm run test:ui:browser
npm run test:ui:visual
npm run build:ui
```

Run all TypeScript and backend checks with:

```bash
npm run check
npm run test:server
```

The production build is written to `public/ui/` and is generated during the
Docker image build. `/` redirects to the React application at `/ui/`. Visual
fixtures write simulator screenshots and a manifest under `test-results/ui-visual/`.

Adaptive Charging includes an Away Schedule for exact From/Until periods. Future
periods can be edited or deleted, while an active period can be ended with Back
Home or extended. Completed periods are hidden from the management table but
remain in SQLite so Away demand can be learned separately from normal household
demand and reused in later charging plans.

SMTP notifications are configured from System → Notifications and
are disabled by default. They can report Charging Demand Guard transitions,
schedule failures, device outages and recoveries, Adaptive Charging availability,
discounted charging-window shortfalls, and an optional low-SOC threshold.
SMTP connections are limited to ports 25, 465, and 587. Port 465 uses implicit
TLS when selected with TLS mode; ports 25 and 587 normally use STARTTLS.
Non-secret settings and delivery state are stored transactionally in
`/data/history.sqlite`. The SMTP password remains separately stored in
`/data/notification-secrets.json` and is never returned by the API.

### Final storage architecture

Application configuration and state, schedules, automation data, telemetry,
aggregates, Adaptive Charging context, and notification delivery history are all
stored in `/data/history.sqlite`. SMTP credentials remain separately stored in
`/data/notification-secrets.json` so secrets are not returned by the API.

Existing installations must run the architecture bridge release before upgrading
to this cleanup release. Confirm the bridge result through `/api/config`:
`runtime.architecture.state` and `runtime.architecture.validation.state` must be
`complete`/`passed`, and `runtime.architecture.architectureVersion` must be `1`.
This release refuses to start with an older or unversioned database instead of
accessing devices with incomplete application state. New installations create the
current architecture directly and require no migration.

The cleanup release no longer reads, writes, or imports the former JSON and JSONL
stores. They may be removed from `/data` after the bridge backup has been retained
and the cleanup release has restarted successfully. Do not remove
`history.sqlite`, `notification-secrets.json`, or the `backups/` directory.

### History storage

Telemetry, aggregates, Adaptive Charging context, automation events, and notification
delivery history are stored in `/data/history.sqlite`.

Retention is configured in System → Data & backups. Defaults preserve raw telemetry for 1,095
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
