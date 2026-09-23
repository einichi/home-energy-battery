export type DeviceCommandArguments = Record<string, unknown>;
export type DeviceCommandExecutor = (
  command: string,
  arguments_: DeviceCommandArguments,
  positional: unknown[],
) => Promise<unknown>;

export type DeviceCommandContext = {
  command: string;
  host: string | null;
  startedAt: string;
};

export type DeviceCommandTiming = DeviceCommandContext & {
  sequence: number;
  durationMs: number;
};

type QueueOptions = {
  priority?: number;
  queueTimeoutMs?: number;
};

type QueueItem = {
  command: string;
  arguments_: DeviceCommandArguments;
  positional: unknown[];
  priority: number;
  sequence: number;
  queuedAt: number;
  queueTimeout: NodeJS.Timeout | null;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

function hostArgument(arguments_: DeviceCommandArguments): string | null {
  for (const key of ["host", "battery-host", "solar-host"]) {
    const value = arguments_[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

export function deviceCommandPriority(command: string): number {
  if (["set-mode", "charge", "discharge", "vendor-profile", "discharge-limit", "osaifu-charge-window", "osaifu-discharge-window", "raw-set"].includes(command)) return 0;
  if (["energy-status", "meter-status"].includes(command)) return 10;
  if (["discover", "probe", "inspect-host", "dump-eoj", "dump-vendor"].includes(command)) return 30;
  return 20;
}

export class DeviceCommandQueue {
  readonly #queue: QueueItem[] = [];
  readonly #queueTimeoutMs: number;
  readonly #starvationMs: number;
  #executor: DeviceCommandExecutor;
  #running = false;
  #sequence = 0;
  #timingSequence = 0;
  #activeContext: DeviceCommandContext | null = null;
  readonly #recentTimings: DeviceCommandTiming[] = [];

  constructor(options: {
    executor: DeviceCommandExecutor;
    queueTimeoutMs: number;
    starvationMs: number;
  }) {
    this.#executor = options.executor;
    this.#queueTimeoutMs = options.queueTimeoutMs;
    this.#starvationMs = options.starvationMs;
  }

  get isRunning(): boolean {
    return this.#running;
  }

  get activeContext(): DeviceCommandContext | null {
    return this.#activeContext;
  }

  get recentTimings(): readonly DeviceCommandTiming[] {
    return this.#recentTimings;
  }

  setExecutor(executor: DeviceCommandExecutor): () => void {
    if (typeof executor !== "function") throw new TypeError("device command executor must be a function");
    const previous = this.#executor;
    this.#executor = executor;
    return () => {
      this.#executor = previous;
    };
  }

  run(
    command: string,
    arguments_: DeviceCommandArguments = {},
    positional: unknown[] = [],
    options: QueueOptions = {},
  ): Promise<unknown> {
    const priority = Number.isFinite(Number(options.priority)) ? Number(options.priority) : deviceCommandPriority(command);
    if (this.#queue.length >= 100 && priority > 0) {
      return Promise.reject(new Error(`device command queue is full; ${command} was not queued`));
    }
    let queued!: QueueItem;
    const task = new Promise<unknown>((resolve, reject) => {
      queued = {
        command,
        arguments_,
        positional,
        priority,
        sequence: ++this.#sequence,
        queuedAt: Date.now(),
        queueTimeout: null,
        resolve,
        reject,
      };
      this.#queue.push(queued);
    });
    const queueTimeoutMs = Number.isFinite(Number(options.queueTimeoutMs))
      ? Math.max(1, Number(options.queueTimeoutMs))
      : this.#queueTimeoutMs;
    queued.queueTimeout = setTimeout(() => {
      const index = this.#queue.indexOf(queued);
      if (index < 0) return;
      this.#queue.splice(index, 1);
      queued.reject(new Error(`ECHONET ${command} timed out after waiting ${queueTimeoutMs}ms in the device command queue`));
    }, queueTimeoutMs);
    void this.#runNext();
    return task;
  }

  async #runNext(): Promise<void> {
    if (this.#running || !this.#queue.length) return;
    this.#running = true;
    const now = Date.now();
    this.#queue.sort((left, right) => {
      const leftStarved = now - left.queuedAt >= this.#starvationMs;
      const rightStarved = now - right.queuedAt >= this.#starvationMs;
      if (leftStarved !== rightStarved) return leftStarved ? -1 : 1;
      if (leftStarved) return left.sequence - right.sequence;
      return left.priority - right.priority || left.sequence - right.sequence;
    });
    const queued = this.#queue.shift();
    if (!queued) {
      this.#running = false;
      return;
    }
    if (queued.queueTimeout) clearTimeout(queued.queueTimeout);
    try {
      const startedMs = Date.now();
      const context: DeviceCommandContext = {
        command: queued.command,
        host: hostArgument(queued.arguments_),
        startedAt: new Date(startedMs).toISOString(),
      };
      this.#activeContext = context;
      try {
        queued.resolve(await this.#executor(queued.command, queued.arguments_, queued.positional));
      } catch (error) {
        queued.reject(error);
      } finally {
        this.#recentTimings.push({
          ...context,
          sequence: ++this.#timingSequence,
          durationMs: Date.now() - startedMs,
        });
        if (this.#recentTimings.length > 100) this.#recentTimings.shift();
        if (this.#activeContext === context) this.#activeContext = null;
      }
    } finally {
      this.#running = false;
      queueMicrotask(() => void this.#runNext());
    }
  }
}
