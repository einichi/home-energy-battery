import type { Server } from "node:http";

export interface RuntimeLogger {
  log(message: string): void;
}

export interface RuntimeStartOptions {
  server: Server;
  host: string;
  port: number;
  validateEnvironment(): void;
  validateStorage(): Promise<void>;
  initializeApplication(): Promise<void>;
  logger?: RuntimeLogger;
}

export interface RuntimeStopOptions {
  server: Server;
  stopBackgroundProcesses(): void;
  closeResources(): Promise<void>;
}

export async function startRuntime(options: RuntimeStartOptions): Promise<void> {
  options.validateEnvironment();
  await options.validateStorage();
  await options.initializeApplication();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      options.server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      options.server.off("error", onError);
      resolve();
    };
    options.server.once("error", onError);
    options.server.once("listening", onListening);
    options.server.listen(options.port, options.host);
  });
  (options.logger ?? console).log(`HOME ENERGY & BATTERY listening on http://${options.host}:${options.port}`);
}

export async function stopRuntime(options: RuntimeStopOptions): Promise<void> {
  options.stopBackgroundProcesses();
  if (options.server.listening) {
    await new Promise<void>((resolve, reject) => {
      options.server.close((error) => error ? reject(error) : resolve());
    });
  }
  await options.closeResources();
}
