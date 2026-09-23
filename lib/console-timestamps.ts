const INSTALLED = Symbol.for("home-energy-battery.console-timestamps-installed");

type WritableConsole = {
  [INSTALLED]?: boolean;
  debug?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

export function localIsoTimestamp(value: Date | string | number = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (number: number, width = 2) => String(Math.abs(number)).padStart(width, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
  const offsetRemainder = Math.abs(offsetMinutes) % 60;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
    + `${offsetSign}${pad(offsetHours)}:${pad(offsetRemainder)}`;
}

export function timestampConsole(consoleObject: WritableConsole = console, now: () => Date = () => new Date()): boolean {
  if (consoleObject[INSTALLED]) return false;
  for (const level of ["debug", "error", "info", "log", "warn"]) {
    const key = level as keyof Pick<WritableConsole, "debug" | "error" | "info" | "log" | "warn">;
    const method = consoleObject[key];
    if (typeof method !== "function") continue;
    const write = method.bind(consoleObject);
    consoleObject[key] = (...args: unknown[]) => write(`[${localIsoTimestamp(now())}]`, ...args);
  }
  Object.defineProperty(consoleObject, INSTALLED, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return true;
}
