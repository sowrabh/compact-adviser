// Shared helpers for the development scripts: the Claude Code binary under test and a
// child environment that neither nests inside a running Claude session nor inherits its
// configuration directory.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CLAUDE = process.env.COMPACT_TEST_CLAUDE_BIN || "claude";

export function claudeEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name === "CLAUDECODE" || name === "CLAUDE_CONFIG_DIR" || name.startsWith("CLAUDE_CODE_")) {
      delete env[name];
    }
  }
  return { ...env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: "1", ...extra };
}

export function run(args, options = {}) {
  const result = spawnSync(CLAUDE, args, {
    encoding: "utf8",
    cwd: PACKAGE,
    env: claudeEnv(options.env),
    timeout: options.timeoutMs ?? 120000,
    ...options.spawn,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

export function claudeVersion() {
  return run(["--version"]).output.trim();
}

/** One shell word: single-quoted, so `$`, backticks, and quotes in it stay literal. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/** `NAME='value' ...` for an `env -i` command line, from a child environment. */
export function shellExports(env) {
  return Object.entries(env)
    .filter(([name, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && value !== undefined)
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" ");
}
