function finiteCounterValue(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export const COUNTER_POLICIES = Object.freeze({
  grid: Object.freeze({
    maximum: 1_000_000_000,
    maximumDelta: 100,
    maximumRatePerHour: 100,
    resolution: 0.01,
  }),
  fuelCellElectricity: Object.freeze({
    maximum: 0xffff_ffff / 1000,
    maximumDelta: 10,
    maximumRatePerHour: 5,
    resolution: 0.001,
  }),
  fuelCellGas: Object.freeze({
    maximum: 0xffff_ffff / 1000,
    maximumDelta: 5,
    maximumRatePerHour: 10,
    resolution: 0.001,
  }),
  circuit: Object.freeze({
    maximum: 0xffff_ffff / 100,
    maximumDelta: 100,
    maximumRatePerHour: 20,
    resolution: 0.01,
  }),
});

export function cumulativeCounterDeltaResult(current, previous, policy = {}, elapsedSeconds = null) {
  const now = finiteCounterValue(current);
  const before = finiteCounterValue(previous);
  if (now === null || before === null) return { delta: null, issue: null };

  const maximum = finiteCounterValue(policy.maximum);
  let delta;
  let issue = null;
  if (now >= before) {
    delta = now - before;
  } else if (maximum !== null && before > maximum * 0.9 && now < maximum * 0.1) {
    delta = maximum - before + now;
    issue = "rollover";
  } else {
    return { delta: null, issue: "reset" };
  }

  const fixedMaximum = finiteCounterValue(policy.maximumDelta) ?? Number.POSITIVE_INFINITY;
  const seconds = finiteCounterValue(elapsedSeconds);
  const maximumRatePerHour = finiteCounterValue(policy.maximumRatePerHour);
  const resolution = finiteCounterValue(policy.resolution) ?? 0;
  const elapsedMaximum = seconds !== null && maximumRatePerHour !== null
    ? maximumRatePerHour * seconds / 3600 + resolution * 2
    : Number.POSITIVE_INFINITY;
  if (delta > Math.min(fixedMaximum, elapsedMaximum) + Number.EPSILON) {
    return { delta: null, issue: "invalid-jump" };
  }
  return { delta, issue };
}

export function finiteCounterMap(channels = []) {
  const out = {};
  for (const channel of channels) {
    const id = Number(channel?.channel);
    const value = finiteCounterValue(channel?.value);
    if (!Number.isInteger(id) || id < 1 || id > 252 || value === null) continue;
    out[String(id)] = value;
  }
  return out;
}
