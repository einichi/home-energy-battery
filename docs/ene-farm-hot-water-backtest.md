# Ene-Farm hot-water forecast investigation

## Decision

Include hot-water level as a guarded, short-horizon input to generation
forecasts. Keep the existing P80 headroom-preservation charging policy unchanged.
The coarse 0–5 tank reading is used to select comparable historical days, not
converted to litres, thermal energy, or a fixed electrical-generation budget.

## Data and method

Read-only production history supplied 4,820 half-hour rollups covering July 1
through October 9, 2026. Of these, 3,947 had valid hot-water levels, beginning
July 19. Private household samples are not committed to the repository.

At every completed half-hour boundary, train on observations already available
at that origin, within the same 90-day window used by live planning. Compare the
existing forecast with hot-water conditioning at identical origins and future
targets. Score only complete half-hour intervals with at least 80% power
coverage, against measured interval-average generation power.

Conditioning requires a level reading no older than 45 minutes and at least four
distinct historical candidate days with the same level at the equivalent
historical **origin**. Existing time/season/occupancy/temperature/recent-state
selection remains in place. Across midnight, the historical origin is on the
preceding calendar date; future target-time tank readings are never used as
predictors. Conditioning applies to target starts no more than six hours ahead;
missing/stale/invalid readings, insufficient matches, or later targets retain
the original forecast.

The export did not include historical weather. Both models therefore used the
same temperature fallback. The supplied Away period was outside the evaluated
range. Results describe this matched comparison, not an exact replay of every
historical live plan.

## Results

| Evaluation set | Median-prediction MAE, baseline → conditioned | P80 pinball loss, baseline → conditioned | P80 coverage, baseline → conditioned |
| --- | --- | --- | --- |
| All future intervals ending within six hours | 90.92 → 84.77 W (**6.8% lower**) | 36.85 → 35.47 W (**3.7% lower**) | 91.32% → 91.22% |
| Intervals where conditioning had enough support | 90.02 → 75.95 W (**15.6% lower**) | 35.34 → 32.14 W (**9.1% lower**) | 91.10% → 90.94% |

There were 53,500 overlapping forecast/actual comparisons within six hours and
25,666 supported conditioned comparisons overall. The latter includes intervals
starting exactly six hours ahead and ending six-and-a-half hours ahead. Supported
comparisons spanned 72 UTC origin dates. These counts are correlated forecasts,
**not independent trials**.

The chronological halves both improved on supported predictions: median MAE
fell 9.2% and 16.6%, respectively; P80 loss fell 11.7% and 8.5%. P20 loss improved
slightly overall, but worsened in the first half's supported cohort, so the
benefit is not uniform across quantiles or periods.

The measured P80 coverage remained above 80% and approximately unchanged. This
supports better forecast quality without changing the planner's preference for
preserving headroom. It does not establish financial savings, all-season
generalization, or the accuracy of an interval-total P80 scenario. That would
require separate trajectory and charging-outcome validation.

## Reproduction and implementation

Run `TZ=Asia/Tokyo npm run backtest:fuel-cell -- /path/to/history.json` with a
half-hour `/api/history` export. Optional `awayPeriods` and `temperatureByDay`
inputs enable a fuller context comparison. The script makes no network requests
or device commands. Lower pinball loss means better quantile forecasts; P80 loss
penalizes underprediction more strongly than overprediction.

The adaptive-history loader now retains hot-water readings, and live plan
refreshes include the normalized current primary-device tank reading alongside
the selected generation reading. Model diagnostics expose the current usable
level and number of conditioned planning slots. Forecast tests cover sparse and
stale data, tank bounds, explicit missing readings, future-data exclusion,
unsorted samples, distinct-day support, and cross-midnight origins.

Only read-only production API requests were made for this investigation. No
production settings, charging plans, or deployment were changed.
