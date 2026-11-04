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
import { lockSync } from "proper-lockfile";
import { DEFAULT_JUDGE, JUDGES, type JudgeName } from "./judge.ts";
import { parseProfile } from "./profile.ts";

export type Mode = "hint" | "auto" | "off";
export const MAX_SAVED_API_KEY_LENGTH = 1024;
export interface Config {
  version: 1;
  mode: Mode;
  minContextTokens: number;
  /** Tokens at which the hint floor is fully relaxed; 0 uses the model's window. */
  contextBudgetTokens: number;
  autoAcknowledged: boolean;
  /**
   * 2 once automatic mode was acknowledged with walk-away compaction in its disclosure; an
   * acknowledgement without it predates that and does not confirm auto.
   */
  consentVersion?: 2;
  logRequests: boolean;
  /** Minutes after a settled answer before walk-away compaction; 0 follows the cache TTL. */
  idleMinutes?: number;
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

/** Whether automatic mode was acknowledged with its current disclosure. */
export function autoConfirmed(config: Config): boolean {
  return config.autoAcknowledged && config.consentVersion === 2;
}

/** Each judge's saved-key field and the words the menu and messages use for it. */
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
  minContextTokens: 40000,
  contextBudgetTokens: 0,
  autoAcknowledged: false,
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
function validate(value: unknown): Config {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid settings.");
  const c = value as Record<string, unknown>;
  if (
    c.version !== 1 ||
    !["hint", "auto", "off"].includes(String(c.mode)) ||
    typeof c.minContextTokens !== "number" ||
    !Number.isSafeInteger(c.minContextTokens) ||
    c.minContextTokens <= 0 ||
    (c.contextBudgetTokens !== undefined &&
      (typeof c.contextBudgetTokens !== "number" ||
        !Number.isSafeInteger(c.contextBudgetTokens) ||
        c.contextBudgetTokens < 0)) ||
    typeof c.autoAcknowledged !== "boolean" ||
    (c.logRequests !== undefined && typeof c.logRequests !== "boolean") ||
    (c.typesafeApiKey !== undefined && typeof c.typesafeApiKey !== "string") ||
    (c.openaiApiKey !== undefined && typeof c.openaiApiKey !== "string") ||
    (c.judge !== undefined && !JUDGES.includes(c.judge as JudgeName)) ||
    (c.consentVersion !== undefined && c.consentVersion !== 2) ||
    (c.idleMinutes !== undefined &&
      (typeof c.idleMinutes !== "number" || !Number.isFinite(c.idleMinutes) || c.idleMinutes < 0))
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
    autoAcknowledged: c.autoAcknowledged,
    ...(c.consentVersion === 2 ? { consentVersion: 2 as const } : {}),
    logRequests: c.logRequests === true,
    ...(typeof c.idleMinutes === "number" ? { idleMinutes: c.idleMinutes } : {}),
    ...(judge !== undefined ? { judge } : {}),
    ...(typesafeApiKey !== undefined ? { typesafeApiKey } : {}),
    ...(openaiApiKey !== undefined ? { openaiApiKey } : {}),
    ...(c.profile !== undefined ? { profile: c.profile as string } : {}),
  };
}
export class ConfigStore {
  readonly path: string;
  constructor(agentDir: string) {
    this.path = join(agentDir, "compact-adviser.json");
  }
  read(): Config {
    return this.load(validate);
  }
  private load<T>(parse: (value: unknown) => T): T {
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384)
        throw new Error("Unsafe settings file.");
      return parse(JSON.parse(readFileSync(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return parse({ ...DEFAULT_CONFIG });
      throw new Error("Cannot read compact-adviser settings; automatic action is disabled.", {
        cause: error,
      });
    }
  }
  update(patch: Partial<Omit<Config, "version">>): Config {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // A short cross-process lock serializes read/merge/write. Contention is reported,
    // never hidden by overwriting another session's field update.
    const release = lockSync(this.path, { realpath: false, stale: 10000 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      // Validate the merge, not the stored file first, so a patch can repair the field that
      // made the file invalid (such as `judge: "jev"` for a Jev-only profile); fields it does
      // not touch must still be valid.
      const stored = this.load((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("Invalid settings.");
        return value as Record<string, unknown>;
      });
      const config = validate({ ...stored, ...patch });
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.path);
      return config;
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        // Best-effort cleanup of a preferences-only temporary file; always release the lock.
      }
      release();
    }
  }
}
