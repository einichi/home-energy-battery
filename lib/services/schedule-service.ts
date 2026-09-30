import type { BatterySchedule } from "../contracts/schedules.js";

export interface ScheduleDocumentStore {
  readDocument(key: "schedules", fallback: BatterySchedule[]): BatterySchedule[];
  writeDocument(key: "schedules", value: BatterySchedule[]): unknown;
}

export function createScheduleService(store: ScheduleDocumentStore) {
  let mutationQueue: Promise<unknown> = Promise.resolve();

  async function read(): Promise<BatterySchedule[]> {
    return store.readDocument("schedules", []);
  }

  async function write(schedules: BatterySchedule[]): Promise<BatterySchedule[]> {
    store.writeDocument("schedules", schedules);
    return schedules;
  }

  function mutate<T>(mutator: (schedules: BatterySchedule[]) => Promise<T> | T): Promise<T> {
    const task = mutationQueue.then(async () => {
      const schedules = await read();
      const result = await mutator(schedules);
      await write(schedules);
      return result;
    });
    mutationQueue = task.catch(() => undefined);
    return task;
  }

  return { mutate, read, write };
}
