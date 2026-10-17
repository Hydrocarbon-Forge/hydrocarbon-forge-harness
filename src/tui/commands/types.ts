/* intra-tui */ import type { TuiAction } from "../state/actions.js";
/* intra-tui */ import type { TuiState } from "../state/types.js";

export type CommandCategory = "core" | "state" | "config" | "control";

export interface SlashCommandDef {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  category: CommandCategory;
  handler: (args: string, state: TuiState) => TuiAction | void;
}

export interface SlashCommandRegistry {
  register(def: SlashCommandDef): void;
  get(nameOrAlias: string): SlashCommandDef | undefined;
  list(): SlashCommandDef[];
  resolve(input: string): { def?: SlashCommandDef; args: string } | null;
}
