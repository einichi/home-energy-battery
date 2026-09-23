# UI Overhaul Proposal

## Executive summary

HOME ENERGY & BATTERY is no longer a small monitoring-and-control utility. It is now a local home energy operations application with live telemetry, historical analysis, battery controls, adaptive charging, safety automation, schedules, forecasts, tariffs, savings and emissions reporting, notifications, device discovery, data retention, and database backup.

The interface should reflect that maturity. The proposed overhaul replaces the current widget catalogue and long settings page with a task-oriented product organized around four questions:

1. **What is happening now?** — Overview
2. **What is the system going to do?** — Battery & Automation
3. **What happened, and was it effective?** — History & Insights
4. **Is the system healthy and correctly configured?** — Equipment & System

The result should feel like dependable household infrastructure: calm during normal operation, explicit when action is needed, and cautious around commands that change physical equipment.

## Current-state assessment

The current UI successfully exposes a large amount of functionality without a build step, but its original structure no longer matches the product.

- The dashboard renders seven similar trend cards followed by a much larger collection of status and statistics cards. Live state, automation state, daily outcomes, savings, equipment details, and warnings have the same visual weight.
- Each graph is a separate navigation destination even though users will commonly compare demand, generation, grid, and battery behavior together.
- Battery controls are under Settings, although charging profile, reserve, backup preparation, direct actions, schedules, and demand guard are core operational features.
- Adaptive Charging has a dedicated workspace but its configuration is separated from it in Settings.
- Settings combines product controls and administration: battery operation, schedules, automation, solar forecast inputs, Ene-Farm tariffs, notifications, display preferences, widget ordering, addresses, discovery, circuits, rates, emissions, retention, and backups.
- The top-level service indicator reports only “online,” while actual device or automation degradation appears deeper in the app.
- The current responsive layout stacks desktop cards and forms, but does not change the task model for quick phone checks and urgent actions.
- Numeric priority fields for dashboard layout expose implementation detail instead of a direct reorder interaction.

These are signs of feature growth, not failures of the existing implementation. The redesign should preserve the underlying capabilities while giving them durable homes.

## Product principles

### 1. State before data

The first screen should answer whether the home is importing, exporting, charging, discharging, or operating normally before it presents individual measurements.

### 2. Decisions before configuration

Show what automation decided, why, and what it will do next. Configuration should be adjacent but secondary.

### 3. Exceptions earn attention

Normal states stay visually quiet. Warnings, stale readings, device loss, forecast degradation, schedule failures, and manual overrides receive progressive emphasis based on urgency.

### 4. Controls belong to the feature they operate

Battery controls live with Battery. Adaptive Charging configuration lives with its plan. Rate inputs live with Costs. Settings is reserved for equipment, communication, storage, and application preferences.

### 5. Physical actions require trust

Every command should show the target device, intended state, current state, execution progress, and verified readback. Potentially disruptive actions should require confirmation and clearly explain which automation will be paused or overridden.

### 6. Complexity is disclosed progressively

The default experience supports daily use. Forecast diagnostics, model versions, raw device details, and retention tuning remain available without crowding primary workflows.

### 7. Local-first is a feature

Make local operation, last successful device contact, data freshness, and external dependencies such as weather and SMTP legible. Avoid cloud-product conventions that imply remote availability or multi-user collaboration.

## Proposed information architecture

Use a stable left rail on desktop and a five-item bottom navigation on phone. “Energy,” “Battery,” and “Automation” are operational areas; “Insights” explains outcomes; “System” contains administration.

```text
Overview

Energy
  Live & history
  Circuits
  Ene-Farm

Battery
  Status & control
  Schedules
  Disaster Prep

Automation
  Adaptive charging
  Demand guard
  Away schedule
  Activity

Insights
  Energy
  Costs & savings
  Carbon
  Forecast performance

System
  Equipment
  Electricity & gas rates
  Notifications
  Data & backups
  Preferences
```

On mobile, the primary tabs should be **Home**, **Energy**, **Battery**, **Automation**, and **More**. Insights and System sit under More. Graph types become controls inside Energy rather than permanent navigation entries.

## Screen proposals

### Overview: the daily operating surface

The Overview is intentionally opinionated rather than customizable by default.

```text
┌ System normal · updated 12 sec ago                    [Alerts]
├──────────────────────────────────────┬────────────────────────┐
│ Live energy flow                     │ Battery                │
│ Solar ─┐                             │ 68% · discharging 0.8kW │
│ Ene-Farm ─┼─ Home ─ Grid             │ Reserve 30%             │
│ Battery ─┘                           │ [Battery details]       │
├──────────────────────────────────────┼────────────────────────┤
│ Energy sources and Ene-Farm activity │ Next automation action │
│ At-a-glance daily composition        │ Charge 02:00–05:30      │
│ [Open detailed Energy history]        │ Target 84% · high conf. │
├──────────────────────────────────────┴────────────────────────┤
│ Today: used · self-powered · imported · exported · cost      │
├───────────────────────────────────────────────────────────────┤
│ Attention / recent activity (only when meaningful)           │
└───────────────────────────────────────────────────────────────┘
```

Key changes:

- Replace separate live-value cards with one energy-flow composition. It should visualize direction and magnitude without animated decoration that makes the screen restless.
- Keep the aligned, multi-series comparison chart in Energy, where its period and series controls support deliberate exploration. Overview links to that workspace instead of duplicating it.
- Give State of Charge, reserve, operating mode, and charge/discharge state one coherent Battery card.
- Summarize the next automation action with a plain-language reason and link to the full plan.
- Keep daily outcomes in a single strip instead of separate large cards.
- Move Ene-Farm hot-water level to Overview only when it is low or explicitly pinned; otherwise it belongs on the Ene-Farm screen.
- Replace “Service online” with a system health summary such as “All equipment reporting,” “1 device stale,” or “Automation paused.”

Custom overview layouts can return later as an advanced preference. The mature default should be good enough that most users do not need to design their own dashboard.

### Energy: comparison instead of graph destinations

Energy becomes the primary exploration surface.

- A shared time-range control appears once: Live, 1h, 8h, 24h, 3d, 7d, 30d, Custom.
- A metric picker controls series on a single synchronized chart.
- Summary values above the graph match the selected period and distinguish instantaneous power (kW) from accumulated energy (kWh).
- A source-balance view explains where household energy came from and where local generation went.
- Circuits use a sortable table or ranked bar chart with name, current W, period kWh, share, and trend. Circuit renaming is done inline.
- Ene-Farm receives a focused subpage for generation, state timeline, hot water, starts, runtime, gas, and efficiency.
- Data completeness and estimated-versus-exact status are visible wherever they can change interpretation.

### Battery: a first-class operational area

Battery consolidates functionality currently split across Dashboard and Settings.

The primary screen contains:

- SOC, power, verified operation mode, charging profile, reserve, and latest device contact.
- A 24-hour battery power/SOC chart with reserve and scheduled windows overlaid.
- A “Current strategy” explanation: manual profile, scheduled command, adaptive plan, demand-guard intervention, away mode, or Disaster Prep.
- Direct controls for profile and reserve with current values preselected.
- An always-visible, clearly separated **Manual control** area for raw charge, discharge, standby, and operation-mode commands.
- A command receipt after every action: requested, sent, device acknowledged, readback verified, or failed.

Schedules become a subpage with a timeline/calendar presentation, human-readable recurrence, next run, last result, and conflict warnings. Creation uses a guided form: **when → action → value → review**, rather than displaying every payload field at once. When Adaptive Charging is enabled, schedules remain visible for reference but are clearly marked as paused and cannot be created or enabled.

Disaster Prep becomes a named operational mode with a persistent banner across the app while active. Its Start action requires a plain-language confirmation covering the temporary backup profile, reserve behavior, demand-guard permission, affected automation, and automatic restoration when stopped. The English UI must not append Japanese text to the label; when localization is implemented, the Japanese label will be **停電対策**.

### Automation: one control center

Automation unifies Adaptive Charging, Charging Demand Guard, Away Schedule, and the activity log.

The landing view is organized by status:

- Master summary: Running, Learning, Paused, Needs setup, or Degraded.
- Next action and the reason for it.
- Active protections, including breaker headroom and backup-mode constraints.
- Today/tonight plan timeline.
- Recent interventions and failed actions.

Adaptive Charging uses three tabs:

1. **Plan** — timeline, selected discounted windows, target SOC, forecast confidence, and assumptions.
2. **Performance** — solar, demand, battery, and Ene-Farm forecast outcomes with a consistent exact/estimated vocabulary.
3. **Configuration** — location, array, capacity, power, limits, and confidence margin. Prerequisites are presented as a setup checklist with direct links rather than one long “Unavailable” sentence.

Demand Guard displays breaker limit, live headroom, intervention thresholds, current state, and recent interventions together. Away periods appear on the same automation timeline and have fast “Away now” and “Back home” actions.

Logs should use structured event rows: severity, timestamp, actor, action, reason, result. Raw diagnostic prose can remain behind a details disclosure.

### Insights: answer questions, not just report values

Rename Reports to Insights and organize it around outcomes:

- **Energy:** use, import/export, solar coverage, self-consumption, peak demand.
- **Costs & savings:** estimated bill impact, solar savings, off-peak savings, Ene-Farm scenarios.
- **Carbon:** avoided grid emissions and the explicitly limited Ene-Farm electricity-only balance.
- **Forecast performance:** prediction error, confidence, coverage, and whether the model influenced automation.

Every report should have a consistent period picker, comparison period, definition/help affordance, data-quality indicator, summary cards, chart, and detailed table. Avoid mixing daily, month-to-date, and lifetime values within a single visual row.

Cost results must visibly say “estimate,” show the tariff basis and data coverage, and link to the applicable rate configuration.

### System: administration rather than a catch-all Settings page

Split the current Settings content into short, routed pages with their own save state.

- **Equipment:** installed features, device cards, address/EOJ, last seen, health, rediscover, inspect, and fallback/proxy relationships.
- **Rates:** electricity modes and bands, Ene-Farm gas provider/plan, imported tariff months, emissions factors.
- **Notifications:** channel configuration, event policy, cooldowns, test result, delivery history.
- **Data & backups:** database health, retention, maintenance, backups, restore, and migration state.
- **Preferences:** language, refresh rate, units if added later, and advanced Overview customization.

Auto-discovery should be a guided workflow that reports progress and offers discovered devices for review before updating saved equipment. Database restore and destructive retention actions must remain visually separated and confirmed.

## Cross-cutting interaction model

### Global health and alerts

A global status control in the app shell aggregates:

- device freshness and outages;
- automation paused/degraded state;
- schedule or command failures;
- incomplete configuration;
- notification delivery failures;
- database maintenance or migration state.

Opening it shows an alert center with severity, start time, impact, suggested action, and resolution state. Do not use warning color merely for missing optional equipment or features intentionally disabled.

### Freshness and offline behavior

- Show “updated N sec ago” near live state.
- Mark individual readings stale without blanking the rest of the screen.
- Preserve the last known value with timestamp when safe; never present it as live.
- Explain when discovery pauses polling.
- Distinguish application availability, LAN reachability, device read failure, and external weather/SMTP failure.

### Commands and overrides

Use one command pattern everywhere:

```text
Review → Send → Acknowledge → Verify readback → Record activity
```

Low-risk value changes can save inline. Manual charge/discharge, standby, backup preparation, restoring a database, and commands that suspend automation require an impact confirmation. Buttons must remain busy until a terminal result and should never imply success before readback.

Manual overrides should include an optional duration or explicit “until changed” label. Their presence is persistent and visible on Overview, Battery, and Automation.

### Empty, learning, and unavailable states

Treat these as different conditions:

- **Not configured:** show the missing prerequisite and action.
- **Learning:** show progress toward the required evidence.
- **Unavailable:** show the failed dependency and last successful state.
- **No data in period:** offer a different period and show collection start date.
- **Feature disabled:** explain what enabling it changes; do not style it as a fault.

## Visual design direction

The current restrained palette is a useful starting point. Evolve it into a semantic system rather than replacing it with a decorative theme.

- Base: warm near-white canvas, white/very-light panels, ink text, slate secondary text.
- Brand/interactive: deep teal.
- Energy semantics: solar amber, grid import red, export green, battery teal, Ene-Farm violet. Use these consistently across flow, charts, legends, and labels.
- State semantics: neutral, success, caution, critical, and informational tokens distinct from energy-source colors.
- Typography: tabular numerals for measurements; clear separation among page title, section title, label, primary value, unit, and metadata.
- Density: 8 px spacing system, 44 px minimum touch targets, compact tables on desktop, card rows on phone.
- Elevation: borders and subtle tonal grouping first; shadows only for floating layers and important overlays.
- Motion: limited to state transitions and command progress, with reduced-motion support. Avoid continuously animated flow lines.
- Icons: a small, coherent outlined set used with text, never as the sole carrier of meaning.

Light and dark modes are both part of the initial design system. Use semantic color tokens from the start so every surface, border, chart, state, focus ring, and data visualization has an intentional value in each theme. The default should follow `prefers-color-scheme`, with an explicit Light / Dark / System preference stored locally. Dark mode should use deep neutral surfaces rather than pure black, retain the established energy-source colors at accessible contrast, and avoid excessively bright chart fills in a room at night.

Theme support is complete only when normal, warning, critical, disabled, stale, selected, hovered, and focused states have been verified in both modes. Charts, browser color-scheme metadata, native controls, empty states, and printable reports must not be left with light-only styling.

## Responsive strategy

Do not merely stack the desktop screen.

- **Desktop (≥1200 px):** fixed navigation, two-column operational layouts, dense comparison tables.
- **Tablet (768–1199 px):** compact rail, primary content plus drawers for filters/configuration.
- **Phone (<768 px):** bottom navigation, single-column summaries, sticky current-state header, full-screen detail sheets, and a condensed flow view.
- On phone, keep SOC, current power direction, system health, and the next automation action above the fold.
- Wide charts become horizontally stable rather than horizontally scrollable; reduce series and let the user select details.
- Tables transform into labeled rows, preserving units and exact/estimated state.

## Accessibility and localization

- Target WCAG 2.2 AA for contrast, focus visibility, keyboard operation, semantics, and touch sizes.
- Never depend on red/green or direction alone; combine color with labels, signs, or icons.
- Provide a data-table alternative or accessible summary for all canvas charts.
- Announce command progress and results with appropriate live regions without repeating routine polling.
- Keep English and Japanese layout parity. Design labels and buttons for expansion rather than hard-coded widths.
- Centralize number, date, time, currency, unit, and plural formatting. Do not concatenate translated fragments.
- Use `kW` for instantaneous power, `kWh` for accumulated energy, and signed values only where direction is otherwise unambiguous.

## Frontend architecture recommendation

The overhaul will use **React with TypeScript, built by Vite**. React is the conservative long-term framework choice for a feature-mature interface: it provides a well-understood component and state model, broad compatibility with UI, accessibility, charting, and testing libraries, and a large contributor knowledge base. Vite supplies the development server, TypeScript/JSX transformation, module updates, and optimized static production build while the existing Node server, HTTP API, SQLite storage, background jobs, and LAN device integration remain in place ([React existing-project guide](https://react.dev/learn/add-react-to-an-existing-project), [Vite guide](https://vite.dev/guide/)).

Target source layout:

```text
frontend/
  index.html
  src/
    main.tsx
    app/
      App.tsx
      router.tsx
      providers.tsx
    api/
      client.ts
      contracts.ts
      queries.ts
      commands.ts
    components/
      AppShell.tsx
      HealthCenter.tsx
      Metric.tsx
      EnergyFlow.tsx
      TimeRange.tsx
      CommandDialog.tsx
      StatusBanner.tsx
    features/
      overview/
      energy/
      battery/
      automation/
      insights/
      system/
    hooks/
      useEnergyStatus.ts
      useBatteryCommands.ts
      useSystemHealth.ts
    i18n/
      en.ts
      ja.ts
    styles/
      tokens.css
      base.css
      components.css
    test/
      fixtures/
      render.tsx
  tsconfig.json
  vite.config.ts

public/ui/                    generated production frontend; not hand-edited
server.ts                     compiled backend composition root
lib/                          typed domain, service, HTTP, runtime, and adapter modules
tests/support/
  device-simulator.js         only device adapter allowed in UI development
```

Architecture boundaries:

- **React owns rendering and interaction.** Migrated route DOM must not also be mutated by legacy selectors or event handlers.
- **TypeScript contracts describe browser-facing API data.** They should not import server implementation objects directly; runtime validation is required where uncertain API data enters the application.
- **Server state and local UI state remain distinct.** Polling and cache state should not be copied into multiple ad hoc contexts. Dialog visibility, selected tabs, and draft form values stay local unless another route genuinely consumes them.
- **Use a small provider layer.** React context is appropriate for stable global capabilities such as theme, locale, command coordination, and system health. Do not put every telemetry value into one monolithic context that rerenders the entire application.
- **Avoid a large state library initially.** Add one only after a measured coordination or performance problem cannot be addressed with focused hooks, context, and the API/query layer.
- **Generated assets are deployment artifacts.** The existing Node process serves the Vite production output; Vite is not a second production server.

Benefits for this project:

- **Predictable shared state:** status polling, freshness, equipment health, automation strategy, command progress, and manual overrides can be expressed through focused hooks and providers.
- **Safer command surfaces:** confirmation, acknowledgement, verified readback, failure, and retry states become typed reusable components.
- **Incremental migration:** React can mount into a dedicated route outlet while unmigrated screens continue to operate. Overview migrates first; a flag-day rewrite is unnecessary.
- **Type-safe view models:** nullable readings, exact versus estimated values, feature-dependent data, and command outcomes become explicit.
- **Ecosystem compatibility:** React libraries work directly without a compatibility layer or React-version lag.
- **Testable simulator states:** normal, stale, offline, learning, degraded, command-timeout, and readback-mismatch states render without live equipment.
- **Contributor familiarity:** the architecture is more likely to be immediately legible to future contributors.

Costs and constraints:

- A frontend build step and generated asset directory become part of Docker and local development.
- React has a larger download and browser-memory footprint than Preact, although charts, retained telemetry, and leaks are expected to dominate total tab memory. Measure production builds rather than relying on framework microbenchmarks.
- React does not choose routing, API query, form, or testing conventions; these must be selected deliberately and kept minimal.
- React should not coexist indefinitely with broad imperative DOM mutation. Each migrated route gets one rendering owner and a defined legacy-removal checkpoint.
- Dependency breadth is a risk as well as a benefit. Every component, state, or styling package requires a demonstrated need.
- Long-running behavior must be tested: route unmounts must release timers, subscriptions, canvases, observers, and cached data.

Additional architectural changes:

- Introduce real URL routes (`/energy`, `/battery`, `/automation`) with history support, deep linking, and a Node static fallback for client routes.
- Separate server data into stable view models for overview, equipment health, automation summary, and reports rather than making every screen reinterpret one large status payload.
- Create a semantic token layer and reusable components before page migration.
- Preserve current feature flags so unavailable equipment removes irrelevant navigation and content cleanly.
- Keep translations in dedicated locale modules and test for missing keys and English/Japanese layout parity.
- Add screenshot-based responsive regression coverage for core states: normal, stale, offline, warning, manual override, learning, and empty history.
- Add a production-build memory scenario that polls, changes routes and chart ranges repeatedly, then verifies that retained heap reaches a stable plateau.

## Development safety and source-control isolation

### Never develop against production devices

The UI overhaul must not send discovery probes or control commands to production household equipment during development, automated testing, visual review, or screenshot generation.

- Use the typed `tests/support/device-simulator.ts` adapter (compiled before launch) and isolated temporary data directories for all development and test states.
- Add a dedicated development command that always sets `NODE_ENV=test`, `DEVICE_COMMAND_ADAPTER_MODULE`, a simulator scenario, a non-production port, and a temporary `DATA_DIR`.
- Fail closed: development mode must refuse to fall back to the real ECHONET Lite adapter if the simulator is missing or fails to initialize.
- Do not copy production device addresses, SMTP credentials, notification recipients, history databases, or secret files into development fixtures.
- Disable outbound SMTP, external tariff mutation, and any other side effect by default in the development profile. Weather responses should be fixture-backed where deterministic UI states are required.
- Give the simulated environment an unmistakable persistent banner and document its port so it cannot be mistaken for the live household instance.
- Cover physical-command flows through simulated acknowledgement, delay, rejection, timeout, and readback-mismatch scenarios before any deliberate production acceptance test.
- If final hardware validation is later required, define it as a separate, explicitly authorized checklist with safe initial conditions and one command at a time. It is not part of routine UI development.

### Work on a new branch

Implementation branch preparation is complete:

- Source branch: `feature/adaptive-solar-charging`
- Base commit: `c387631`
- Overhaul branch: `ui/operations-overhaul`
- Created directly from the source branch tip before implementation work

All overhaul implementation must remain on `ui/operations-overhaul` unless an explicitly reviewed successor branch is created from it. Do not move this work to an older default branch or silently mix it into production-device and automation development.

Preserve unrelated work, keep the overhaul isolated from ongoing device/automation changes, and integrate updates from the original branch deliberately as implementation proceeds.

## Implementation readiness checklist

The architectural decision and branch are ready. Begin implementation in this order:

1. **Add the safe development launcher first.** It must create an isolated temporary data directory, force `NODE_ENV=test`, force the compiled `tests/support/device-simulator.ts` adapter, disable outbound side effects, use a documented non-production port, and abort if any real adapter or production data path is selected.
2. **Add React, React DOM, TypeScript, Vite, and the official Vite React plugin.** Record exact supported versions in the lockfile and keep the first dependency set intentionally small.
3. **Create the `frontend/` source tree and build contract.** Define development proxying to the existing API, production output location, source maps, static asset handling, and Node fallback behavior for client routes.
4. **Establish quality gates before feature work.** Add type-check, production-build, unit-test, lint, and simulator-backed browser-test commands. Existing server tests remain mandatory.
5. **Implement foundations only.** Build semantic light/dark tokens, locale and formatting providers, the app shell, route skeletons, error boundary, loading/empty/stale primitives, and typed API client.
6. **Deliver one read-only vertical slice.** Implement Overview against simulator fixtures before exposing any React control that can issue a device command.
7. **Add command infrastructure separately.** Only after acknowledgement/readback/timeout/mismatch tests exist should Battery controls migrate.

The first implementation checkpoint is complete when a production React build renders a responsive light/dark app shell and read-only Overview using only simulated data, all legacy tests still pass, browser tests show no unexpected network destinations, and no device-command endpoint is callable from the new UI.

## Delivery plan

### Phase 0 — isolated foundations

- Create the overhaul branch from the current branch tip and verify the base commit.
- Add the fail-closed simulated development profile before opening or exercising any new control surface.
- Inventory current controls, API dependencies, translated strings, and safety-critical actions.
- Define power/energy sign conventions, freshness thresholds, state vocabulary, and exact/estimated rules.
- Add routes, light/dark semantic design tokens, shared formatting, health aggregation, and command lifecycle primitives without changing behavior.

**Exit:** all development runs against the simulator on the isolated branch; existing functionality can be reached through the new shell; command and telemetry semantics are documented and tested; both themes cover the shared component states.

Implementation details and the route/API/telemetry inventory are maintained in
`frontend/MIGRATION_CONTRACT.md` so subsequent phases share one definition of
freshness, data quality, sign conventions, route ownership, and command states.

### Phase 1 — Overview and Energy

- Build the global shell, health center, energy flow, combined chart, period controls, daily outcome strip, and mobile navigation.
- Consolidate graph destinations into Energy while keeping old entry points as temporary redirects.

**Exit:** normal household status is understandable in under ten seconds on desktop and phone; all current live/history metrics remain accessible. The telemetry-parity checkpoint below closes the remaining specialized dashboard views before Phase 3 begins.

**Implemented:** the React Overview now combines live flow, battery state,
daily source/activity summaries, and today's outcomes. Energy provides Live through 30-day
periods, selectable power/SOC/hot-water series, an accessible chart table,
quality/coverage context, battery balance, and circuit totals. Specialized circuit graphs, source composition, Ene-Farm activity/details, and the complete off-peak savings split remain assigned to Phase 2.5. Legacy graph URLs
redirect to the matching focused Energy series. The route remains read-only and
is covered by simulator-backed desktop and phone browser checks.

### Phase 2 — Battery and command safety

- Move battery controls, schedules, Disaster Prep, and direct actions out of Settings.
- Implement confirmations, progress, verified readback, and activity receipts.

**Exit:** every physical command has an explicit, tested lifecycle and no battery function depends on the legacy Settings layout.

**Implemented:** Battery is now a first-class routed React workspace. Its primary
view combines live SOC, power, verified mode, profile, reserve, latest contact,
server-owned strategy, preselected controls, an always-visible manual-control area,
and a 24-hour power/SOC chart with reserve and operating windows. Schedules have
their own seven-day calendar, human recurrence, next run and last result,
conflict warnings, and a when → action → value → review editor. Disaster Prep
has a dedicated view, an impact preview covering profile, reserve,
Demand Guard and restoration, and a persistent application-level banner.

Physical actions use an impact review and an observable server lifecycle with
immutable requested, sending, acknowledged, verifying, and terminal events.
The UI stays pending until the durable receipt is terminal, reports mismatch and
failure without false success, and displays recent activity. Success requires
fresh device readback. Simulator-backed integration tests cover every exposed
battery command plus acknowledgement delay, rejection, timeout, readback
mismatch, manual-override visibility, Disaster Prep persistence, desktop
and phone navigation, and both themes without production-device access. The
existing schema-v7 event store is reused; no database migration is introduced.

### Phase 2.5 — telemetry and dashboard parity

Complete the read-only capabilities that were present on the legacy dashboard before expanding operational automation:

- Add Smart Cosmo circuit history graphs using the existing per-channel history samples, with circuit selection, configured labels, shared time ranges, current power, period energy, and data-quality context.
- Restore an **Energy Sources** proportional bar on Overview for peak grid, off-peak grid, on-site solar, and Ene-Farm contribution. Its period and denominator must be explicit, and it must retain numeric values alongside color.
- Restore the **Ene-Farm Activity** state bar for generating, starting, stopping, idle, and stopped intervals.
- Add a focused Ene-Farm view containing the legacy operational statistics: electricity generated, gas used, operating time, starts, time in the current state, last stop, current generation state, and hot-water level/trend.
- Restore Off-Peak Savings with explicit **Total**, **Grid use**, and **Battery charging** views for today, last month, month to date, and year to date. All values remain labeled as estimates with tariff basis and coverage available.
- Keep these surfaces read-only and source them from the existing status/history/report APIs; do not introduce new device commands or production-device testing.

**Exit:** every specialized live/history item listed above is available in React, legacy values can be reconciled against the same simulator fixture, missing or disabled equipment has an intentional empty state, and desktop/phone plus light/dark browser fixtures pass.

**Implemented:** Overview now shows the daily Energy Sources composition with
peak grid, off-peak grid, on-site solar, and Ene-Farm values; an Ene-Farm state
timeline; and Off-Peak Savings toggles for Total, Grid use, and Battery charging
across today, last month, month to date, and year to date. Energy adds a
time-range-aware Smart Cosmo circuit selector with per-circuit history, hover
readout, accessible table, current power, and period energy. It also includes an
Ene-Farm activity timeline plus electricity, gas, operating time, starts, time
in state, last stop, average generating power, electrical yield, hot-water level,
and data-quality statistics. All data comes from existing status, history, and
Ene-Farm endpoints; no schema change or new device command was added.

### Phase 3 — Automation

- Merge Adaptive Charging, Demand Guard, Away Schedule, prerequisite setup, and activity.
- Introduce Plan, Performance, and Configuration views and a shared automation timeline.

**Exit:** a user can explain the next automated action and its reason from one screen.

**Implemented:** the React Automation route now combines Adaptive Charging,
Demand Guard, Away Schedule, prerequisite setup, and activity. Plan derives a
master state, next action and plain-language reason, breaker headroom, Disaster
Prep priority, operational ownership, a shared Adaptive Charging/Away timeline,
selected discounted windows, forecast assumptions and confidence, and structured
automation and device-command activity from the existing APIs.

Performance separates current solar, demand, battery, and Ene-Farm estimates from
their available recorded outcomes and learning evidence. It explicitly identifies
that the current API has demand-model evidence but no settled demand-error series.
Configuration owns Adaptive Charging, battery planning limits, and Demand Guard.
Automation-affecting saves use an impact review and clear success or failure state;
resume requires an explicit review, while recalculation reports its terminal result.
Away periods can be created, started immediately after reviewing the return time,
edited, extended, removed, or ended with Back home. Every change queues a fresh
plan through the existing server behavior. No database schema change was required.

### Phase 4 — Insights and System

- Rework reports into outcome-oriented Insights, expanding the Phase 2.5 savings summary into period comparison, definitions, and detailed tables without removing its three-way off-peak breakdown.
- Split equipment, rates, notifications, data/backups, and preferences into routed administration pages.
- Replace numeric dashboard priorities with direct show/hide and drag/reorder only if advanced customization remains necessary.

**Exit:** no catch-all settings page remains; every current setting and report has a stable task-oriented home.

**Implemented:** `/ui/insights` consumes the existing energy and Ene-Farm report
APIs with 30-day, 90-day, 12-month, and custom date ranges; daily, weekly, and
monthly grouping; recorded outcome cards; a comparable energy trend; explicit
coverage; estimated savings, gas-cost, and carbon labels; and exact detail tables.
Periods without samples remain disclosed, break chart continuity, and are omitted
from tabular evidence rather than being presented as measured zero.

`/ui/system` now routes equipment, rates and emissions, notifications, data and
backups, and preferences to separate task-oriented pages. Existing configuration,
notification, discovery, retention, backup, and report endpoints are reused.
Simulator development disables external notification delivery and published tariff
imports. No database schema change or production-device access has been introduced.
The completed parity audit includes Smart Cosmo circuit names, default visibility
and sorting; notification trigger parameters, password state and delivery history;
and retention, backup compatibility, confirmation, operation progress, and refreshed
inventory. React routes no longer depend on the legacy catch-all Settings page.

### Phase 5 — hardening and removal

**Implemented.** React is now the only UI served by the application. The root
redirects to `/ui/`; the legacy markup, scripts, styles, chart utility, and route
shims have been removed. English and Japanese use a shared catalog and
locale-aware formatting, including the localized `停電対策` label. Keyboard skip
navigation, expanded focus treatment, responsive phone/tablet fixtures, dark and
light theme fixtures, and simulator-only browser coverage now protect the main
workflows and adverse UI states.

The final hardening pass also makes installed-device values suggestion-only until
edited, reports asynchronous discovery progress, keeps save results beside the
form that produced them, and normalizes preference-control sizing and label case.
Energy circuit rows now select the circuit graph and all columns are sortable;
Overview surfaces the five highest live circuit loads. A single configured
off-peak window satisfies the Automation pricing prerequisite, while multi-rate
pricing remains optional. Mobile navigation now follows the planned five-item
model—**Home**, **Energy**, **Battery**, **Automation**, and **More**—with Insights
and System available from More. Ene-Farm also has a focused routed detail view.
These refinements reuse the existing configuration, discovery-job, status, and
history contracts and require no database migration.

Energy now presents its analysis period above the complete historical workspace,
rather than inside Combined History. The selected range drives every period-based
card, is repeated in each section's scope label, and shows an announced loading
state while switching. Smart Cosmo labels are read-only by default; explicit batch
editing freezes the current circuit order until save or cancel.

The completion hardening adds compact and bounded history view models so Overview
does not transfer raw five-second samples and long-range charts use interval
rollups. It adds a source-labelled alert center, per-reading stale/unavailable
states, conditional Overview attention, runtime response validation, print styles,
English/Japanese coverage for the new operational surfaces, and explicit loading
versus no-data states. Simulator gates now cover browser behavior, fourteen responsive
theme/locale/adverse-state screenshots, accessibility semantics, and repeated
client-side navigation/polling with a measured heap ceiling. Production devices,
production data, outbound notification delivery, and tariff imports remain outside
all development and automated verification.

- Completed accessibility, localization, phone/tablet, stale, warning, empty-history, manual-override, and lifecycle testing through simulator-backed gates.
- Centralized English/Japanese message lookup and locale-aware formatting; labels never concatenate both languages, and **Disaster Prep** is **停電対策** in Japanese.
- Added responsive visual regression fixtures using the existing device simulator.
- Removed legacy page markup, duplicate chart implementations, obsolete CSS, and route shims during the React cutover.

**Exit:** feature parity is documented; critical workflows pass automated and manual acceptance tests; legacy UI code is removed.

## Success criteria

The overhaul is successful when:

- A user can determine current import/export direction, battery state, system health, and next automation action without scrolling on a typical laptop and phone.
- Core measurements appear once on Overview and are explored together in Energy instead of repeated as equal-weight cards.
- Battery operations and automation are reachable in one top-level action from anywhere in the app.
- No administration page contains unrelated operational controls.
- Disabled, unconfigured, learning, stale, and failed states are visually and semantically distinct.
- Every device-changing command produces a persistent verified result or a clear failure.
- All existing features remain reachable with English/Japanese parity and keyboard support.
- The default Overview requires no customization for ordinary use.
- New features can be assigned to an existing product area without adding another dashboard card or expanding a monolithic settings screen.

## Explicitly out of scope

To keep the overhaul proportional to this local project, the first release should not add:

- remote access, accounts, roles, or multi-home management;
- a cloud backend or external analytics service;
- drag-and-drop dashboard construction as a headline feature;
- real-time WebSocket infrastructure solely for visual smoothness—the existing polling model can remain if freshness is communicated accurately;
- control of Ene-Farm, which remains observation and forecasting only;
- tariff-provider expansion beyond the data and configuration the application already supports;
- user-authored themes beyond the built-in Light, Dark, and System choices;
- decorative animation before the operational workflows are complete.

## Recommended first design milestone

Produce a high-fidelity, responsive prototype of four linked states before rewriting the full UI:

1. Overview under normal operation
2. Overview with stale equipment and a paused automation
3. Battery with a manual command confirmation and verified result
4. Adaptive Charging with an active plan and an unmet prerequisite state

Use real labels, units, simulated values, and Japanese expansion cases from this repository. Treat that prototype as the contract for tokens, navigation, component states, and responsive behavior; then implement it vertically through real APIs before expanding to the remaining pages.
