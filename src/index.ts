import { createBot } from "./discord/bot.js";
import { log } from "./log.js";

const bot = createBot();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info(`${sig}: shutting down`);
    bot.shutdown().finally(() => process.exit(0));
  });
}

bot.start().catch((err) => {
  log.error("failed to start", err);
  process.exit(1);
});
