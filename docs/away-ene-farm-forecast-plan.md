# Away-period ENE-FARM forecasting proposal

Status: implemented. The sections below retain the design rationale and planned
structure. The implementation uses a 10 W material-generation threshold,
30 minutes of sustained covered generation, a rolling 24-hour quiet window,
90% minimum coverage, a maximum one-hour gap, and a 45-minute freshness limit.
Evidence is stored in the existing durable adaptive-state document. The baseline
P80 allowance is deliberately retained in every regime; no empirical Away data
has yet justified reducing it. Missing/stale observations use the baseline
forecast. Offline forecast replay is implemented; charging outcomes continue to
use the existing planner-backtest engine with model version 3.

## Assessment

Use each Away period as evidence about the ENE-FARM's operating regime for that
trip. Begin with an expectation of little or no generation, strengthen it after
a well-observed non-generating operating cycle, and use the ordinary generation
model when sustained generation contradicts it. Keep reassessing throughout the
period. A single day's behavior is evidence, not a guarantee about future days.

Prefer the ordinary model over copying the first day's power profile. The model
already accounts for time, season, temperature, recent generation state and,
where supported, the 0–5 hot-water level. Generation near departure can be a
carryover run that ends when the tank fills.

An important distinction: zero generation is conservative when estimating how
much energy the battery needs, but optimistic when deciding how much battery
headroom to reserve. The initial off expectation must not automatically make
every forecast quantile zero.

## Existing implementation

- `lib/domain/demand-forecast.ts`: `buildFuelCellGenerationModel` uses historical
  half-hour generation. Historical fuel-cell days are currently tagged by
  occupancy at noon; comparable-day selection uses that tag, day type, season
  and temperature. It has no period-specific operating-regime inference.
- `lib/domain/adaptive-planning.ts`: P20 generation supplies the low-generation
  energy scenario; P80 supplies the headroom scenario. Active model slots require
  at least four historical days. Model readiness separately requires seven valid
  days and four comparable days.
- `lib/domain/time.ts`: Away uses exact start/end instants and a separate demand
  forecast return buffer of up to 30 minutes.
- `lib/services/adaptive-evaluation-lifecycle.ts`: Away start/end and extension
  can queue replanning; generation-regime changes currently cannot.
- `lib/services/adaptive-history-service.ts`: planning history includes power,
  generation state, tank level and coverage metadata, over a 90-day window.
- `docs/ene-farm-hot-water-backtest.md`: the existing model comparison did not
  evaluate Away behavior. It cannot establish this proposal's accuracy.

## Proposed policy

October 26 correction: planner version 4 sets the upper scenario to zero only
after a full, fresh, well-covered quiet cycle. Provisional and uncertain periods
retain the baseline upper scenario. A generation observation or stale evidence
restores that allowance and queues a refresh, including upgrades from a stored
quiet-trip policy that retained headroom. Across all regimes, headroom yields to
the low-generation energy needed before the next charging window, capped by the
configured maximum SOC. Physical charging shortfalls remain visible. The zero
upper scenario is a policy decision, not an empirical quantile calibration.

| State | Interpretation | Forecast behavior within this period |
| --- | --- | --- |
| Provisional off | Period has begun, or is scheduled; insufficient post-departure evidence | Off expectation for P20/median; retain a supported upper-generation scenario for headroom |
| Off supported | A full observation cycle has adequate valid coverage and no material generation | Carry the off expectation through the remaining period; reduce the upper scenario only as evidence supports it |
| Normal model | Sustained post-departure generation contradicts the off expectation | Use the ordinary ENE-FARM model without the target Away suppression; continue Away household-demand forecasting |
| Uncertain | Missing/stale data, contradictory signals or insufficient coverage | Show uncertainty and retain/widen plausible generation bounds; do not infer observed zero |

These states describe a forecast policy, not appliance commands. An unsupported
headroom estimate must retain the existing unavailable-plan behavior rather than
silently treating unknown generation as zero. A policy scenario must not be
reported as an empirically calibrated P80 until calibration supports that claim.

### Observation rules

1. Start evidence collection at the exact `from` instant. Ignore earlier
   generation and clip rollups that cross the boundary. Scheduled periods cannot
   use observations from their future first day.
2. Use a rolling 24-hour observation cycle from departure, rather than the few
   hours remaining in the local calendar day. Require coverage of the usual
   generation hours. Shorter trips remain provisional unless reliable evidence
   establishes a different regime.
3. Use measured power/energy and actual coverage. Starting/stopping/idle status
   alone does not establish material generation, and a cached reading does not
   gain freshness when a plan refreshes. Require distinct observations and avoid
   double-counting raw samples and rollups.
4. Initial candidate defaults: at least 90% coverage of the observation cycle,
   no gap over 60 minutes, and sustained generation over a 30-minute interval
   above an appliance-appropriate noise threshold. Validate these defaults
   against available history; do not assume a universal wattage threshold.
5. Reliable new generation immediately invalidates a confident-off headroom
   assumption and queues a replan. Promote to normal-model behavior after
   sustained evidence. Continue using recent-state and hot-water conditioning;
   do not interpret a brief departure-time run as proof of continuous output.
6. Reassess at least daily and on material new evidence. Sustained later silence
   can restore an off-supported state; a momentary normal overnight stop cannot.
   Use separate promotion/demotion criteria to avoid oscillation.
7. Carry a supported state across an extension with the same start and device.
   Reset it for a changed start or device, or a new period. Bound all effects to
   the exact Away interval. End the fuel-cell adjustment at Back Home/`until`;
   the existing household-demand return buffer remains a separate policy.
8. Apply this only for a configured, enabled ENE-FARM. Honor observe-only mode:
   expose the adjusted forecast without enabling control participation.

## Implementation sequence

1. **Pure inference module.** Add `lib/domain/away-fuel-cell.ts` with explicit
   inputs for period identity, device identity, observation time, previous
   evidence, and covered telemetry intervals. Return regime, reason, evidence
   window, coverage, generation evidence, freshness and next review time. Do not
   access clocks or devices implicitly.
2. **Durable evidence.** Store the derived evidence separately from the editable
   Away schedule, keyed by period/start/device and inference version. Preserve
   it across restarts and trips longer than the 90-day planning-history window.
   Update it idempotently and retain transitions for audit/backtesting. Period
   extensions preserve evidence; changed starts/devices invalidate it.
3. **Forecast integration.** Pass the regime into
   `buildFuelCellGenerationModel`. In normal-model mode use normal/home
   fuel-cell analogues while keeping actual historical Away labels intact.
   Replace the noon-only historical occupancy tag with interval-aware matching
   so partial departure/return days do not contaminate candidate selection.
   Preserve hot-water conditioning and distinguish baseline readiness from the
   support for a period-specific adjustment.
4. **Planner integration.** Apply the policy only to overlapping Away portions
   of timeline slots; split slots at exact boundaries where necessary. Express
   empirical support and policy assumptions explicitly rather than fabricating
   historical sample counts to pass the current four-day gate. Preserve the
   separate energy-deficit and headroom scenarios and existing missing-data
   protections. Return to the baseline outside the period.
5. **Refresh integration.** Update inference during regular telemetry evaluation,
   before deciding whether a new plan is needed. Queue one replan for each
   material regime/confidence change, observation deadline, invalidation or
   period boundary. Reuse the existing pending-request concurrency handling and
   respect manual pause, demand guard and charging-session ownership.
6. **Diagnostics.** Extend plan/state contracts and the Automation view with
   state, reason, observation coverage, last evidence time and whether the
   headroom scenario still allows generation. Add English/Japanese strings and
   log transitions once. Clearly distinguish assumed off from observed off.
7. **Verification.** Add domain, persistence and planner/lifecycle tests for
   confirmed silence, sustained generation, carryover then silence, late starts,
   stale/missing/duplicate data, noisy power, conflicting status, late departure,
   short trips, exact boundaries, return buffer, extension, restart, device
   replacement, disabled/observe-only modes, and forecast readiness failures.
   Verify both grid-charge demand and reserved headroom, not just displayed
   generation. Run the repository checks and relevant server/UI tests.
8. **Historical replay.** Extend the offline fuel-cell backtest to replay
   inference chronologically, using only evidence available at each forecast
   origin. Compare median error, upper/lower scenario calibration, daily energy
   error and simulated charging/headroom outcomes by Away period and trip day.
   Keep periods as the evaluation unit when assessing independence. Record a
   new model version in plan snapshots. If representative Away history is
   unavailable, report that limitation and retain the conservative upper
   scenario until observations justify reducing it.

## Acceptance criteria

- A well-observed non-generating trip maintains an off expectation across
  replans, extensions and restarts.
- A generating trip uses the normal ENE-FARM forecast while Away demand remains
  active; its first-day shape is not blindly repeated.
- Later contradictory evidence revises the prediction and promptly queues a
  plan refresh without repeatedly issuing device commands.
- Missing telemetry never becomes confirmed zero, and no future observations
  enter either live inference or historical replay.
- The UI explains the current assumption and its evidence; headroom uncertainty
  remains visible and supported by the planner's existing protections.

## External behavior references

- [Panasonic operating FAQ](https://www2.panasonic.biz/jp/energy/FC/faq/):
  automatic operation learns household electricity and hot-water usage.
- [Osaka Gas generation-stop FAQ](https://faq.osakagas.co.jp/faq/show/5718):
  depending on model/mode, a full hot-water tank stops generation.
- [Aisin type S automatic stops](https://www.aisin.com/jp/product/energy/cogene/enefarm/manual/2610420/03-06.html):
  this model family documents multiple temporary-stop conditions and automatic
  absence detection after ten days. This is an example of model dependence,
  not a claim about the installed appliance.
