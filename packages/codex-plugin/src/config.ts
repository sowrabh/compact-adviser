// Persistent preferences, with the same semantics as the Pi extension's configuration.
//
// Codex has no plugin-scoped settings surface: unknown keys in `config.toml` are an error
// under `--strict-config`, so the adviser owns one JSON file of its own next to its session
// records. Only the CLI writes it, so a whole-file atomic replace is the whole story; there
// is no lock because there is no concurrent writer to serialize against.
//
// `auto` is not a Codex mode. Nothing outside a Codex session can trigger `/compact`, so this
// host ships hint-only and rejects a hand-edited `auto` rather than pretending to honour it.

import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_JUDGE, JUDGES, type JudgeName } from "./judge.ts";
import { parseProfile } from "./profile.ts";

export type Mode = "hint" | "off";
export const MODES: readonly Mode[] = ["hint", "off"];
export const DEFAULT_MINIMUM = 40000;
export const MAX_SAVED_API_KEY_LENGTH = 1024;
export const SETTINGS_NAME = "settings.json";
/** A settings file larger than this is not one this product wrote. */
const MAX_SETTINGS_BYTES = 16384;

export interface Config {
  version: 1;
  mode: Mode;
  minContextTokens: number;
  /** Tokens at which the hint floor is fully relaxed; 0 uses the model's window. */
  contextBudgetTokens: number;
  logRequests: boolean;
  /** Which model answers the two questions; absent means the Decisions judge. */
  judge?: JudgeName;
  typesafeApiKey?: string;
  openaiApiKey?: string;
  profile?: string;
}

/** The judge a configuration selects. */
export function selectedJudge(config: Config): JudgeName {
  return config.judge ?? DEFAULT_JUDGE;
}

/** Each judge's saved-key field and the words messages use for it. */
export const SAVED_KEY: Readonly<
  Record<JudgeName, { field: "openaiApiKey" | "typesafeApiKey"; label: string; article: string }>
> = {
  decisions: { field: "openaiApiKey", label: "OpenAI API key", article: "an" },
  jev: { field: "typesafeApiKey", label: "TypeSafe API key", article: "a" },
};

/** A judge name, or the reason it is not one. */
export function parseJudge(text: string): JudgeName {
  const value = text.trim();
  if (!JUDGES.includes(value as JudgeName)) throw new Error("Choose a judge: decisions or jev.");
  return value as JudgeName;
}

export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({
  version: 1,
  mode: "hint",
  minContextTokens: DEFAULT_MINIMUM,
  contextBudgetTokens: 0,
  logRequests: false,
});

export function parseMinimum(text: string): number {
  const value = text.trim();
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number <= 0) {
    throw new Error("Enter a positive whole number of tokens, for example 40000.");
  }
  return number;
}

/** A context budget in tokens, or 0 for "off" (the model's window). */
export function parseBudget(text: string): number {
  const value = text.trim();
  if (value === "off") return 0;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number)) {
    throw new Error("Enter a whole number of tokens, for example 450000, or off.");
  }
  return number;
}

export const AUTO_UNAVAILABLE =
  "Automatic compaction is not available on Codex: nothing outside a session can run /compact. Use hint or off.";

export function parseMode(text: string): Mode {
  const value = text.trim();
  if (value === "auto") throw new Error(AUTO_UNAVAILABLE);
  if (!MODES.includes(value as Mode)) throw new Error("Enter hint or off.");
  return value as Mode;
}

export function parseSavedApiKey(text: string, judge: JudgeName = "jev"): string {
  const value = text.trim();
  const { label, article } = SAVED_KEY[judge];
  if (!value) throw new Error(`Enter ${article} ${label}, or cancel to leave it unchanged.`);
  if (value.length > MAX_SAVED_API_KEY_LENGTH) {
    throw new Error(`That value is too long to save as ${article} ${label}.`);
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) {
      throw new Error("The key cannot contain control characters.");
    }
  }
  return value;
}

export function validateConfig(value: unknown): Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid settings.");
  }
  const c = value as Record<string, unknown>;
  if (
    c.version !== 1 ||
    typeof c.mode !== "string" ||
    !MODES.includes(c.mode as Mode) ||
    typeof c.minContextTokens !== "number" ||
    !Number.isSafeInteger(c.minContextTokens) ||
    c.minContextTokens <= 0 ||
    (c.contextBudgetTokens !== undefined &&
      (typeof c.contextBudgetTokens !== "number" ||
        !Number.isSafeInteger(c.contextBudgetTokens) ||
        c.contextBudgetTokens < 0)) ||
    (c.logRequests !== undefined && typeof c.logRequests !== "boolean") ||
    (c.typesafeApiKey !== undefined && typeof c.typesafeApiKey !== "string") ||
    (c.openaiApiKey !== undefined && typeof c.openaiApiKey !== "string") ||
    (c.judge !== undefined && !JUDGES.includes(c.judge as JudgeName))
  ) {
    throw new Error("Invalid or unsupported settings. Restore a valid version-1 configuration.");
  }
  const judge = c.judge as JudgeName | undefined;
  parseProfile(c.profile, judge ?? DEFAULT_JUDGE);
  const savedKey = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  const typesafeApiKey = savedKey(c.typesafeApiKey);
  const openaiApiKey = savedKey(c.openaiApiKey);
  if (
    (typesafeApiKey !== undefined && typesafeApiKey.length > MAX_SAVED_API_KEY_LENGTH) ||
    (openaiApiKey !== undefined && openaiApiKey.length > MAX_SAVED_API_KEY_LENGTH)
  ) {
    throw new Error("Invalid or unsupported settings. Restore a valid version-1 configuration.");
  }
  return {
    version: 1,
    mode: c.mode as Mode,
    minContextTokens: c.minContextTokens,
    contextBudgetTokens: (c.contextBudgetTokens as number | undefined) ?? 0,
    logRequests: c.logRequests === true,
    ...(judge !== undefined ? { judge } : {}),
    ...(typesafeApiKey !== undefined ? { typesafeApiKey } : {}),
    ...(openaiApiKey !== undefined ? { openaiApiKey } : {}),
    ...(c.profile !== undefined ? { profile: c.profile as string } : {}),
  };
}

export class ConfigStore {
  readonly path: string;
  constructor(root: string) {
    this.path = join(root, SETTINGS_NAME);
  }

  read(): Config {
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SETTINGS_BYTES) {
        throw new Error("Unsafe settings file.");
      }
      return validateConfig(JSON.parse(readFileSync(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
      throw new Error("Cannot read compact-adviser settings; no advice is given.", {
        cause: error,
      });
    }
  }

  update(patch: Partial<Omit<Config, "version">>): Config {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const config = validateConfig({ ...this.read(), ...patch });
    writeAtomic(this.path, `${JSON.stringify(config, null, 2)}\n`);
    return config;
  }
}

/** Replaces `path` whole: a temporary file in the same directory, fsynced, then renamed. */
export function writeAtomic(path: string, contents: string): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Best-effort cleanup of a preferences-only temporary file.
    }
  }
}

export function formatTokens(count: number): string {
  return count.toLocaleString("en-US");
}
