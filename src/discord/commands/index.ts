import type { Command } from "./types.js";
import { join } from "./join.js";
import { leave } from "./leave.js";
import { status } from "./status.js";

export const commands: readonly Command[] = [join, leave, status];
export const commandMap = new Map(commands.map((c) => [c.data.name, c]));
