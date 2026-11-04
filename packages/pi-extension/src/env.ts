import { readFileSync } from "node:fs";
import { join } from "node:path";

const NAME = "TYPESAFE_API_KEY";
const PREFIX = /^(?:export|declare\s+-x)\s+/;

export type KeySource = "env" | "saved" | ".env" | "missing";
export interface ResolvedApiKey {
  value: string | undefined;
  source: KeySource;
}
export type TypesafeKeySource = KeySource;
export type ResolvedTypesafeApiKey = ResolvedApiKey;

function unquote(value: string): string {
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) return value.slice(1, -1);
  }
  return value;
}

/** Last `KEY=VALUE` assignment wins. Comments and blank lines are ignored. */
export function parseDotenvKey(text: string, name: string): string | undefined {
  let found: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    line = line.replace(PREFIX, "");
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    if (line.slice(0, eq).trim() !== name) continue;
    found = unquote(line.slice(eq + 1).trim());
  }
  return found;
}

function nonempty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/**
 * Process env (non-empty) wins, then a menu-saved key, then `name` from `.env` in `cwd`.
 * A missing file is ignored; the value is never logged.
 */
export function resolveApiKey(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  saved?: string,
): ResolvedApiKey {
  const fromEnv = nonempty(env[name]);
  if (fromEnv !== undefined) return { value: fromEnv, source: "env" };
  const fromSaved = nonempty(saved);
  if (fromSaved !== undefined) return { value: fromSaved, source: "saved" };
  try {
    const fromFile = nonempty(parseDotenvKey(readFileSync(join(cwd, ".env"), "utf8"), name));
    if (fromFile !== undefined) return { value: fromFile, source: ".env" };
  } catch {
    // A missing or unreadable .env is ignored.
  }
  return { value: undefined, source: "missing" };
}

/** The Jev key: `TYPESAFE_API_KEY` from the process, a saved key, or a cwd `.env`. */
export function resolveTypesafeApiKey(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  saved?: string,
): ResolvedTypesafeApiKey {
  return resolveApiKey(NAME, env, cwd, saved);
}

export function formatKeyStatus(source: KeySource): string {
  return `Key: ${source}`;
}
