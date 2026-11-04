// `claude plugin validate --strict` on this package: the engine's own reading of the hooks
// module must name exactly the events it hooks, the environment it reads, and no
// capability the mod must not use.
import { claudeVersion, PACKAGE, run } from "./common.mjs";

const version = claudeVersion();
const { status, output } = run(["plugin", "validate", "--strict", PACKAGE]);
const hooksLine =
  "hooks: session.start, prompt.submit, command.run, turn.start, turn.complete, session.compact, command.run{command=compact-adviser}, config.describe{key=compact-adviser.typesafeApiKey}, config.describe{key=compact-adviser.openaiApiKey}, ui.close{id=compact-adviser}, ui.render{component=Pane}";
// Measured, not assumed: Claude Code 2.1.275 prints matcher keys unquoted and 2.1.295 and
// later quote them. Compare with the quotes taken out.
const normalized = output.replace(/\{key="([^"]*)"\}/g, "{key=$1}");
const expected = [
  "env reads: CLAUDE_CODE_ENABLE_FUNCTION_HOOKS, COMPACT_ADVISER_DISABLE, COMPACT_ADVISER_TEST_ENDPOINT, HOME, OPENAI_DECISIONS_API_KEY, TYPESAFE_API_KEY, TYPESAFE_BASE",
  "env writes: nothing",
  "$.fs.read (via appendRequestLog, resolvedKey)",
  "$.fs.write (via appendRequestLog)",
  "Validation passed",
];
// `prompt.submit` is intentional: confirmed auto mode may submit `beforeCompactPrompt`.
// A leading slash is `command.run` instead; Claude Code rejects that text on prompt.submit.
const forbidden = ["process.run", "env.set", "prompt.fill", "tool.call", "model."];
const problems = [
  ...(status === 0 ? [] : [`exit status ${status}`]),
  ...(normalized.includes(hooksLine)
    ? []
    : [`missing hooks line (prompt.submit, and the other registered events)`]),
  ...expected.filter((line) => !output.includes(line)).map((line) => `missing: ${line}`),
  ...forbidden
    .filter((call) => output.includes(`$.${call}`))
    .map((call) => `forbidden call: $.${call}`),
];
if (problems.length > 0) {
  process.stderr.write(`${output}\n`);
  console.error(`Claude Code ${version}: strict validation drifted:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(
  `Claude Code ${version}: strict validation passed with the expected hooks and environment reads.`,
);
