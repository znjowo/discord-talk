import { config } from "./config.js";

const t0 = Date.now();
function stamp(): string {
  return `+${String(Date.now() - t0).padStart(7)}ms`;
}

export const log = {
  debug: (...args: unknown[]) => {
    if (config.logLevel === "debug") console.log(stamp(), "[debug]", ...args);
  },
  info: (...args: unknown[]) => console.log(stamp(), "[info] ", ...args),
  warn: (...args: unknown[]) => console.warn(stamp(), "[warn] ", ...args),
  error: (...args: unknown[]) => console.error(stamp(), "[error]", ...args),
  // Latency measurements are the primary quality signal of this project; keep them on a dedicated channel.
  metric: (name: string, ms: number, extra?: string) =>
    console.log(stamp(), "[metric]", name, `${Math.round(ms)}ms`, extra ?? ""),
};
