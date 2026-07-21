const INSTALLED = Symbol.for("home-energy-battery.console-timestamps-installed");

export function localIsoTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (number, width = 2) => String(Math.abs(number)).padStart(width, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
  const offsetRemainder = Math.abs(offsetMinutes) % 60;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
    + `${offsetSign}${pad(offsetHours)}:${pad(offsetRemainder)}`;
}

export function timestampConsole(consoleObject = console, now = () => new Date()) {
  if (consoleObject[INSTALLED]) return false;
  for (const level of ["debug", "error", "info", "log", "warn"]) {
    if (typeof consoleObject[level] !== "function") continue;
    const write = consoleObject[level].bind(consoleObject);
    consoleObject[level] = (...args) => write(`[${localIsoTimestamp(now())}]`, ...args);
  }
  Object.defineProperty(consoleObject, INSTALLED, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return true;
}
