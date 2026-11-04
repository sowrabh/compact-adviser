// Regenerates .claude/types (gitignored) from the installed Claude Code, in a throwaway
// directory and configuration so nothing in the user's Claude Code setup is read or written.
//
// Older engines write the declarations with their own `/plugin-types` command. Newer ones
// (2.1.30x) dropped it and write them into `<plugin>/.claude-plugin/types/` when an interactive
// session loads the plugin, so the fallback starts one under tmux against a dead local API,
// waits for the files, and stops it. No credential or model call is involved either way.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE, claudeEnv, PACKAGE, run, shellExports, shellQuote } from "./common.mjs";

const TARGET = join(PACKAGE, ".claude", "types");
const WRITTEN = join(PACKAGE, ".claude-plugin", "types");
const API_KEY = "sk-ant-types-fixture-not-a-real-key-000";

function fromCommand(lab) {
  const { status, output } = run(["-p", "/plugin-types"], {
    env: { CLAUDE_CONFIG_DIR: join(lab, "config") },
    spawn: { cwd: lab },
    timeoutMs: 60000,
  });
  if (status !== 0 || !output.includes("claude-code.d.ts")) return false;
  rmSync(TARGET, { recursive: true, force: true });
  cpSync(join(lab, ".claude", "types"), TARGET, { recursive: true });
  return true;
}

async function fromSession(lab) {
  const config = join(lab, "config");
  const socket = `compact-adviser-types-${process.pid}`;
  // Onboarding, the fixture key, and trust for the lab, so the session loads straight away.
  writeFileSync(
    join(config, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      customApiKeyResponses: { approved: [API_KEY.slice(-20)], rejected: [] },
      projects: { [lab]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    }),
  );
  rmSync(WRITTEN, { recursive: true, force: true });
  const env = claudeEnv({
    CLAUDE_CONFIG_DIR: config,
    HOME: lab,
    ANTHROPIC_API_KEY: API_KEY,
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
    DISABLE_AUTOUPDATER: "1",
  });
  delete env.COMPACT_ADVISER_DISABLE;
  const exports = shellExports(env);
  const cmd = `env -i ${exports} ${shellQuote(CLAUDE)} --plugin-dir ${shellQuote(PACKAGE)}`;
  const tmux = (...args) => execFileSync("tmux", ["-L", socket, ...args], { stdio: "ignore" });
  tmux("new-session", "-d", "-s", "types", "-x", "120", "-y", "40", "-c", lab, cmd);
  try {
    const declarations = join(WRITTEN, "claude-code", "index.d.ts");
    for (let waited = 0; waited < 60000 && !existsSync(declarations); waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!existsSync(declarations)) return false;
  } finally {
    try {
      tmux("kill-server");
    } catch {}
  }
  rmSync(TARGET, { recursive: true, force: true });
  for (const name of ["claude-code", "claude-code-tools"]) {
    cpSync(join(WRITTEN, name), join(TARGET, name), { recursive: true });
  }
  return true;
}

const lab = realpathSync(mkdtempSync(join(tmpdir(), "compact-adviser-types-")));
try {
  mkdirSync(join(lab, "config"), { recursive: true });
  if (!fromCommand(lab) && !(await fromSession(lab))) {
    throw new Error("Claude Code did not write its plugin API declarations");
  }
} finally {
  // A stopped session may still be flushing into its config directory for a moment.
  rmSync(lab, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
