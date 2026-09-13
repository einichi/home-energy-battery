# UI migration contract

This document is the stable contract for moving the existing interface into the
React application. It prevents later routes from inventing different meanings
for the same telemetry, health, and command states.

## Ownership and route inventory

| Product area | React route | Current source or API | Phase 0 status |
| --- | --- | --- | --- |
| Overview | `/ui/` | `GET /api/status`, `GET /api/config`, `GET /api/history` | Phase 1 read-only live flow, 24-hour chart, daily outcomes |
| Energy and history | `/ui/energy` | `/api/history`, status telemetry, legacy graph views | Phase 1 combined chart, periods, all live metrics, storage balance, quality, and circuits |
| Battery | `/ui/battery` | status battery fields, `/api/actions/*`, `/api/settings/*`, schedules, backup preparation, command receipts | Phase 2 operational workspace |
| Automation | `/ui/automation` | adaptive charging, automation rules, Away periods, schedules, operational overrides | Placeholder |
| Insights | `/ui/insights` | energy and Ene-Farm reports, savings and emissions data | Placeholder |
| System | `/ui/system` | config, discovery, notifications, retention, tariffs, database backup/restore | Placeholder |

React exclusively owns DOM below its root. The legacy application remains the
owner of `/` until each feature is migrated. A migrated route must not use legacy
selectors or event handlers.

English and Japanese labels currently embedded in the `I18N` table in
`public/app.js` are the migration source inventory. They must be mapped to
dedicated React locale modules before a route is declared complete. Missing
translations must fall back visibly during development, not silently render an
empty label.

## Measurement semantics

- Power is instantaneous and displayed in W below 1,000 W and kW at or above it.
- Energy is accumulated over time and displayed in kWh. Power and energy are not
  interchangeable.
- Battery power follows the device convention: positive means charging, negative
  means discharging, and zero means idle. UI copy must state the direction rather
  than relying on the sign alone.
- Grid import and grid export are separate non-negative values. If a signed net
  value is used internally, positive means import and negative means export.
- Solar and Ene-Farm generation are non-negative source values.
- A missing, invalid, or errored measurement is `null`/unavailable. It must never
  be normalized to zero. A real zero remains visible as `0 W` or `0 kWh`.
- API metric objects may contain raw, decoded, human, unit, and error fields. React
  view models use the typed numeric/string `value`; presentation formatting is
  centralized and does not trust server-formatted `human` text as the canonical
  value.

## Freshness and health

The configured polling interval is the baseline:

- **Live:** the snapshot is no more than three polling intervals old, with a
  minimum allowance of 30 seconds.
- **Stale:** a prior snapshot exists but is older than the live threshold.
- **Unavailable:** no usable snapshot exists or the request/device returned an
  error.
- **Degraded:** some configured equipment or automation is stale, unavailable, or
  failed while the rest of the application can still operate.
- **Healthy:** all configured equipment used by the current view has fresh usable
  data and no active failure.

Health summaries must name the affected equipment or subsystem. Color is only a
secondary cue; text and icons carry the state.

## Exact, counter, integrated, and estimated data

- **Counter:** derived from a device cumulative counter and preferred when the
  counter is continuous and valid.
- **Integrated:** calculated from sampled instantaneous power; show coverage when
  gaps can materially affect the result.
- **Estimated:** model-, tariff-, interpolation-, or assumption-derived. Cost,
  savings, carbon, and forecast output must retain this label.
- **Exact:** reserved for directly known configuration or discrete device state.
  It must not be used for sampled energy totals merely because they have many
  decimal places.

Views must preserve the API's quality and coverage metadata. A counter reset,
gap, fallback, or partial period may not be hidden by formatting.

## Command inventory and lifecycle

Safety-critical device actions currently include charging profile, discharge
limit, osaifu charge/discharge windows, operation mode, charge, discharge,
schedules, adaptive-charging resume/recalculation, Demand Guard changes, backup
preparation, discovery, notification delivery tests, retention, and database
restore.

Every physical-device command added to React must use the shared lifecycle:

1. `idle` — no request in progress.
2. `confirming` — target, requested change, consequences, and automation override
   are shown before submission.
3. `sending` — the request has been accepted by the UI and duplicate submission is
   disabled.
4. `acknowledged` — the adapter/device accepted the command.
5. `verifying` — fresh status is read back and compared with the intended state.
6. `succeeded` — acknowledgement and readback agree.
7. `failed`, `timed-out`, or `mismatched` — the UI retains the receipt and gives a
   safe next action.

Phase 0 exposes no React control that calls command, discovery, mutation,
notification-test, tariff-import, retention, or restore endpoints. Those flows
must first have simulator scenarios for acknowledgement, delay, rejection,
timeout, and readback mismatch.

Phase 1 remains read-only. Former individual graph entry points redirect to the
matching selected series on `/ui/energy`; `/` continues to expose every legacy
feature that has not yet migrated.

Phase 2 uses the existing schema-v7 `events` table for immutable command
lifecycle records. A command ID connects `requested`, `sending`, `acknowledged`,
`verifying`, and terminal events. React submits physical commands to
`POST /api/device-commands`, then observes the durable receipt through
`GET /api/device-commands/:id`; it never infers success from the initial HTTP
202 response. Receipt storage has its own retention setting and requires no
database migration.

Battery owns three routed views: status and control at `/ui/battery`, the
seven-day schedule calendar and guided editor at `/ui/battery/schedules`, and
Disaster Prep / 停電対策 at `/ui/battery/backup`. Manual or disaster-prep ownership is
reported by `/api/status` and rendered by the application shell, so its banner
survives route changes. The server remains the authority for strategy ownership,
command acknowledgement, fresh readback comparison, schedule execution, and
Disaster Prep restoration.

## Development boundary

All UI implementation, automated tests, screenshots, and visual review use
`npm run dev:ui` on branch `ui/operations-overhaul`. That launcher is fail-closed:
`NODE_ENV=test`, the repository simulator adapter, external I/O disabled, a
temporary prefixed data directory, and non-production ports are mandatory. Any
later real-hardware acceptance pass requires separate, explicit authorization.
