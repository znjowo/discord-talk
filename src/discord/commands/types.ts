import type {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import type { SessionManager } from "../../voice/manager.js";

export interface CommandContext {
  sessions: SessionManager;
}

export interface Command {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute(interaction: ChatInputCommandInteraction, ctx: CommandContext): Promise<void>;
}

/** Thrown by a command to show a short user-facing message instead of a generic error. */
export class UserError extends Error {}
