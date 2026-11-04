<h1 align="center">compact-adviser</h1>

<p align="center">
  <a href="https://github.com/sowrabh/compact-adviser/blob/main/LICENSE"
    ><img
      alt="License"
      src="https://img.shields.io/badge/license-MIT-green?style=flat-square"
  /></a>
  <a
    href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue?style=flat-square"
    ><img
      alt="Platform"
      src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue?style=flat-square"
  /></a>
  <a href="https://x.com/kunchenguid"
    ><img
      alt="X"
      src="https://img.shields.io/badge/X-@kunchenguid-black?style=flat-square"
  /></a>
  <a href="https://discord.gg/Wsy2NpnZDu"
    ><img
      alt="Discord"
      src="https://img.shields.io/discord/1439901831038763092?style=flat-square&label=discord"
  /></a>
</p>

**compact-adviser** is an agent plugin that answers a single question: should I /compact now?

This is a fork of [kunchenguid/compact-adviser](https://github.com/kunchenguid/compact-adviser). It adds OpenAI's [Decisions API](https://developers.openai.com/api/docs/guides/decisions) as a judge beside TypeSafe's Jev (and makes it the default), and, in automatic mode, decides what to do once you walk away from a session: compact it while its prompt cache is still warm, or keep that cache warm until you come back.

![Compact adviser status line: "Compact adviser: work appears completed or recorded. Run /compact to save tokens." shown above a terminal prompt](https://raw.githubusercontent.com/sowrabh/compact-adviser/main/docs/hint-status-line.png)

It asks a judge, OpenAI's Decisions API (`gpt-6-luna`) by default or [TypeSafe Jev](https://typesafe.ai), whether the current session is likely at a boundary that's safe to compact.

It can give you a hint to run `/compact` - or, on Pi and Claude Code, if you opt in, it can run it for you at the right time automatically. Codex CLI and Grok are hint-only: nothing outside their sessions can trigger `/compact`.

Judgment is two one-sentence questions in one request (is the unit finished; is this hands-on work or coordination), composed in code into one score. Decisions answers each as a probability (a predicate); Jev answers each as a choice. The hint floor is 0.90 while the context is mostly empty (through about 10%) and relaxes toward 0.50 by about 90% full - a wrong hint costs most when there is still room. "Full" means the point where the host compacts: on Claude Code that is its auto-compact threshold when enabled, elsewhere the model's window. If you would rather compact well before that (long contexts cost more every turn), set a context budget: the floor then relaxes as the context approaches the smaller of your budget and that point. Automatic mode is the same gate, plus a first-use confirmation. Each judge has its own floor schedule: Jev's is the measured one above, and Decisions borrows it as a placeholder until it is refit on labelled checkpoints, because OpenAI does not document its probabilities as calibrated.

## Quick Start

Prerequisites: Node 22+ (22.18+ for Codex and Grok), and one of [Pi](https://pi.dev) 0.82.0 or newer (verified on **0.85.1**), Claude Code 2.1.317 or newer (verified on **2.1.318**), Codex CLI 0.153.0 or newer (verified on **0.153.4**), or [Grok Build](https://docs.x.ai/build/overview) 1.0.34 or newer (verified on **1.0.34**), plus an API key for the judge you use: an [OpenAI API key](https://platform.openai.com/api-keys) for the default `decisions` judge, or a [TypeSafe API key](https://console.typesafe.ai/settings/keys) for `jev`. Supply it as `OPENAI_DECISIONS_API_KEY` (or `TYPESAFE_API_KEY`) in the launch environment or put it in the session cwd's `./.env`; Pi and Claude Code can also save it through their settings, while Codex and Grok provide an external compact-adviser CLI. Either judge is only asked two one-sentence classification questions, never to write a summary.

Installing the package is consent to send eligible checkpoint context to the selected judge (OpenAI or TypeSafe) when its key is available and the other product gates pass. With `TYPESAFE_BASE` set, the Jev context and key go to that base instead.

### Pi

```sh
pi install git:github.com/sowrabh/compact-adviser
```

Restart Pi or run `/reload`, then `/compact-adviser`.
`/compact-adviser status` should say `Key: env`, `Key: saved`, or `Key: .env`.

Add `-l` for a project-local install. This fork does not publish to npm.

### Claude Code

This plugin uses Claude Mod which is an experimental feature that requires `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in your environment.

```sh
claude plugin marketplace add sowrabh/compact-adviser
claude plugin install compact-adviser@compact-adviser
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude
```

Then `/compact-adviser`.

### Codex CLI

Codex support is **macOS and Linux only**. The plugin's hooks run through POSIX `sh`, matching
this repository's platform badge; Windows is not supported this ship.

```sh
codex plugin marketplace add sowrabh/compact-adviser
codex plugin add compact-adviser@compact-adviser
```

Restart Codex and review the hook in `/hooks` once, so it is trusted. After a completed
checkpoint the advice appears as a `↳ Hook · Compact adviser: ...` line under the answer.

Codex is **hint-only**: it has no surface that lets another process run `/compact`, so there is
no automatic mode there. Settings live in a small CLI instead of a slash command; ask Codex for
"compact-adviser status" and the bundled skill runs it, or run it yourself:

```sh
node "$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/compact-adviser/*/ | tail -1)src/cli.ts" status
```

### Grok Build

Grok is **hint-only**: nothing outside a running session can trigger `/compact`, so there is no automatic mode here. The hint is painted on the status row and never enters the model's context.

```sh
grok plugin install sowrabh/compact-adviser#packages/grok-plugin --trust
```

(Install from the subdirectory, not the repository root: Grok also reads the Claude marketplace index in this repo, so a plain `grok plugin marketplace add` offers two plugins of the same name and refuses an unqualified install.)

Then two one-time steps, because Grok does not let a plugin do either of them for you. Start Grok and run:

```
/compact-adviser-install
```

That writes `${GROK_HOME:-~/.grok}/hooks/compact-adviser.json`, because **Grok 1.0.34 lists a plugin's own `hooks/hooks.json` but never loads it into a session**. Hooks in your own Grok home are always trusted, so nothing else is needed; delete that file to remove them. From a shell it is `node "$(node -e 'const l=JSON.parse(require("child_process").execFileSync("grok",["plugin","list","--json"],{encoding:"utf8"})); const p=(Array.isArray(l)?l:[]).find(x=>x&&x.name==="compact-adviser"); if(!p||typeof p.path!=="string") throw new Error("compact-adviser is not installed"); process.stdout.write(p.path)')/bin/adviser.ts" install`. After `install`, `${GROK_HOME:-~/.grok}/compact-adviser/adviser.sh` resolves the currently installed plugin the same way.

Then paste the `[ui.status_line]` block `install` printed into the config.toml path it named and restart Grok. The status row is off by default and only your own config can turn it on - a plugin cannot, and neither can a repository. Grok has one status row, so this script paints the built-in segments (`cwd`, `model`, `context`) too. Minimal render mode has no status row at all.

On Grok, set the selected judge's key as `OPENAI_DECISIONS_API_KEY` (or `TYPESAFE_API_KEY`) or in a cwd `.env`, or save it with the CLI `key` command from a shell outside Grok. Do not type secrets after a Grok slash command; Grok appends those words to the model.

## If it does nothing

| Symptom | Cause |
| --- | --- |
| TypeSafe requires payment (HTTP 402) | Check the TypeSafe account's billing and credits; waiting alone will not resolve a payment requirement. Context stays unchanged. |
| OpenAI rejected the API key, or rate-limited the request | Check the OpenAI key and the project's quota; a rate limit backs off and tries again later. Context stays unchanged. |
| `Key: missing` in `/compact-adviser status` (Pi, Claude Code) or `/compact-adviser` (Grok) | No key for the selected judge (`OPENAI_DECISIONS_API_KEY` for `decisions`, `TYPESAFE_API_KEY` for `jev`) in the launch environment, saved settings, or the session cwd's `./.env`. The other judge's key is never used in its place |
| Advice stopped after setting a profile | A profile with `questions` is Jev-only; with the `decisions` judge it disables advice |
| No `/compact-adviser` command in Claude Code | `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is not exactly `1` |
| Command exists, no hint | Context is below the constant 40,000-token minimum, the session is not idle, or the last turn was not a settled final answer |
| Claude Code: "nonessential traffic" | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` blocks plugin network requests |
| No hint in Codex | The hook is untrusted (review it in `/hooks`), Node is older than 22.18, or the hook cannot find Node at all - Codex rebuilds its PATH, so set `COMPACT_ADVISER_NODE` to an absolute `node` path |
| Grok: no hint row at all | `[ui.status_line]` is not set in the `config.toml` `install` named, or Grok is in minimal render mode |
| Grok: no hint after a completed turn | `/compact-adviser-install` has not run, so no Stop hook is judging |
| Pi print / RPC / JSON, Claude `-p`, or `codex exec` | The adviser stays inert in reliably detected non-interactive sessions |
| Nothing at all, in any host | `COMPACT_ADVISER_DISABLE` is set to a truthy value |

## Environment variables

| Variable | Effect |
| --- | --- |
| `OPENAI_DECISIONS_API_KEY` | The key for the default `decisions` judge (OpenAI's Decisions API); a saved key or the session cwd's `./.env` is used when this is unset |
| `TYPESAFE_API_KEY` | The key for the `jev` judge; a saved key or the session cwd's `./.env` is used when this is unset |
| `TYPESAFE_BASE` | Replaces the TypeSafe API base URL, `https://api.typesafe.ai` by default; the request goes to `<base>/v1/systemone` with a trailing slash dropped. Read from the launch environment only, never a saved setting or `./.env`. It must be an `https` URL; plain `http` is accepted only for a loopback host (`127.0.0.1`, `[::1]`, `localhost`). Any other value, or one that carries credentials, a query or a fragment, is a configuration error: no request and no advice |
| `COMPACT_ADVISER_DISABLE` | `1`, `true`, `yes` or `on` (any case) makes the session inert: no judge request, no hint, no automatic compaction, no keep-warm, no command. It wins over a saved `hint` or `auto` mode |
| `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` | Claude Code only; must be exactly `1` for the mod to load |
| `FORCE_PROMPT_CACHING_5M`, `ENABLE_PROMPT_CACHING_1H`, `DISABLE_PROMPT_CACHING` | Claude Code's own prompt-cache switches. The mod reads them (with whether the session reports subscription rate limits, which means a 1-hour cache) to place the walk-away point; it never sets them |
| `PI_CACHE_RETENTION` | Pi's own cache switch; `long` means a 1-hour cache on Anthropic models, otherwise 5 minutes. Read to place the walk-away point |
| `COMPACT_ADVISER_NODE` | Codex only; absolute path to a Node 22.18 or newer executable when the hook cannot find one on its rebuilt PATH |

Export `COMPACT_ADVISER_DISABLE=1` for unattended agent sessions, where advice has nobody to read it.

## What is sent to the judge

| Included | Not sent |
| --- | --- |
| Bounded user constraints, up to the last 64 visible replies and tool results (clipped), short tool-result excerpts, an existing summary, saved-artifact names, omission markers | System prompts, hidden reasoning, images, environment variables, the API key in the model context and request body, complete transcripts |
| Best-effort redaction of known key patterns and obvious sensitive-file results | A guarantee. Uninstall or set mode Off for material that must not leave the machine |

Both judges get the same snapshot. Decisions requests go to `https://api.openai.com/v1/decisions` with model `gpt-6-luna`, the snapshot as JSON evidence, and the two predicate questions. Jev requests go to `https://api.typesafe.ai/v1/systemone`, or `<TYPESAFE_BASE>/v1/systemone` when that is set. Requests are capped at 32,000 serialized UTF-8 bytes, only the selected judge is asked, and an error or a refusal is never an affirmative judgment.
The API key never enters the model context or the request body; it is sent as the Authorization header to authenticate the call.

Keep-warm (Claude Code, automatic mode) sends nothing to either judge. It replays the session's own last request to Anthropic through Claude Code (`$.model.fork`) with one extra line, `Reply with exactly: OK`, on your model quota; neither the line nor the reply enters the transcript.
Details: [SECURITY.md](https://github.com/sowrabh/compact-adviser/blob/main/SECURITY.md).

## How It Works

```
settled turn
      │
      ▼
┌───────────────────┐
│ cheap local gates │  mode, 40k minimum, idle session, key, cooldowns
└─────────┬─────────┘
          ▼
┌───────────────────┐
│ Decisions or Jev  │  done × shape score, floor slides 0.90→0.50 with usage
└─────────┬─────────┘
          ▼
 hint: run /compact     or, with explicit auto, native compaction
          │
          ▼  auto only: no prompt, command or typing until just before the cache lapses
 finished: compact once     unfinished: keep the cache warm (Claude Code), up to 8 h
```

Automatic compaction is available on Pi and Claude Code. On Codex the same judgment only ever
produces the hint, as a `↳ Hook ·` line in the scrollback. On Grok the two halves are separate
processes: a `Stop` hook judges and records a verdict, and the `[ui.status_line]` script reads
that verdict and paints the hint. The Grok hook always allows the stop and prints nothing, so a
hint can never be fed back to the model.

### Walking away (automatic mode)

In confirmed automatic mode, a settled answer also arms a walk-away point on Claude Code and Pi. If nothing happens before it (no prompt, command, turn, typing, or draft in the prompt box), the adviser acts once just before the prompt cache would lapse, so your next turn does not resend the whole context uncached:

- It fires at the cache TTL minus 10 minutes (50 minutes on a 1-hour cache), or 1 minute before a 5-minute cache ends (4 minutes). When the TTL is unknown it uses 50 minutes. `idleMinutes` replaces this with a fixed number of minutes.
- If that answer's turn-end score reaches the schedule's loosest floor (0.50 by default), it compacts once, running `beforeCompactPrompt` first on Claude Code. Backoff, snooze, the wait after a compaction, and the minimum context still apply.
- Otherwise, including when the judge failed or was not asked, it never compacts. On Claude Code it keeps the cache warm instead: a one-line fork of the session's own request each cache cycle, up to `keepWarmHours` (8 by default; 0 turns it off). It stops on a ping that misses the cache, on a failed fork, before the session's second exchange, and as soon as you are back. Pi has no keep-warm.

Claude Code's own threshold auto-compact is unchanged and still catches what the adviser does not. Hint mode, Codex and Grok never act on walk-away.

On Claude Code, an optional `beforeCompactPrompt` setting (empty by default; set it in `/config`)
runs one turn before that automatic compaction, and only after auto mode is confirmed. Set it to
`/stow` to run the `stow` command first. Claude Code does not expand slash commands or `@file`
mentions in a prompt a plugin submits, and it rejects a plugin prompt that starts with `/`, so a
value that starts with `/` is run as a command instead of being sent to the model as text. If you
send your own prompt or run a command in between, or that turn is interrupted, errors, or does not
finish within 5 minutes, nothing is compacted. Hint mode, off, and an empty setting are unchanged. Pi, Codex, and
Grok do not have this setting.

## Usage

| Command | Effect |
| --- | --- |
| `/compact-adviser` (Pi and Claude Code) | Settings (mode, minimum, request log, the selected judge's API key, judge) |
| `/compact-adviser auto` / `hint` / `off` (Pi and Claude Code) | Save that mode; auto asks for first-use confirmation, again if it was confirmed before walk-away compaction existed |
| `/compact-adviser judge decisions` / `judge jev` (Pi and Claude Code) | Choose the judge: OpenAI's Decisions API (default) or TypeSafe Jev |
| `/compact-adviser status` (Pi and Claude Code) | Mode, judge, minimum, budget, context, key source (`env` / `saved` / `.env` / `missing`), cooldown, and on Claude Code in auto mode when walk-away fires |
| `/compact-adviser threshold 60000` (Pi and Claude Code) | Save an absolute token minimum |
| `/compact-adviser budget 450000` / `budget off` (Pi and Claude Code) | Save a context budget: the hint floor is fully relaxed at this many tokens, or at the host's own compaction point if that is smaller (off by default) |
| `/compact-adviser snooze` / `dismiss` (Pi and Claude Code) | Suppress the next three exchanges, or clear the current hint |
| `beforeCompactPrompt` in `/config` (Claude Code) | Optional text run before automatic compaction. Empty by default. `/stow` runs that command |
| `idleMinutes` in `/config` (Claude Code), `idleMinutes` in `compact-adviser.json` (Pi) | Minutes after a settled answer before walk-away acts. 0 (default) follows the cache TTL |
| `keepWarmHours` in `/config` (Claude Code) | How long walk-away may keep an unfinished session's cache warm. 8 by default; 0 turns it off |
| `/compact-adviser` (Grok) | Show status; do not add arguments because Grok sends them to the model |
| `/compact-adviser-hint` / `/compact-adviser-off` (Grok) | Save hint-only mode, or disable the adviser |
| `/compact-adviser-snooze` / `/compact-adviser-dismiss` (Grok) | Suppress the next three exchanges, or clear the current hint |
| `/compact-adviser-install` (Grok) | Register the hooks and print the status-line block to paste into the named `config.toml` |
| `${GROK_HOME:-$HOME/.grok}/compact-adviser/adviser.sh threshold 60000` (Grok shell) | Save an absolute token minimum; `budget <tokens\|off>` saves a context budget; `help` lists the other shell-only settings |

On Codex the same commands are arguments to the plugin's `src/cli.ts` (`status`, `hint`, `off`,
`judge <decisions|jev>`, `threshold`, `budget <tokens|off>`, `log on|off`, `key set|clear|status`) rather than a slash
command, because Codex plugins cannot register a command with code behind it. Codex has no
snooze or dismiss: the CLI cannot tell which session is current.

## Judge profiles

An optional [judge profile](https://github.com/sowrabh/compact-adviser/blob/main/docs/judge-profiles.md) changes the two questions (Jev only), score weight, or floor schedule without changing shipped defaults. All four hosts accept the same bounded JSON string in the `profile` setting. Keep hint mode while evaluating a profile. Invalid profiles disable advice, and loading a profile never grants automatic-mode consent.

## Eval

Local judgment eval uses real session checkpoints to score when the adviser should suggest `/compact`. The numbers and the curve below are upstream's measurements of the Jev judge; the Decisions judge has not been measured this way yet. The curve comes from a follow-up-aware gold set (96 checkpoints, 40 sessions): as the context window fills, the score threshold loosens from **0.90** (≤10% used) to **0.50** (≥90% used) so **recall rises** while precision stays high - favoring token savings when compaction is about to be forced anyway.

![Use Jev to answer "should I /compact now?" — precision stays high while recall rises as context used goes from ≤10% to ≥90%](https://raw.githubusercontent.com/sowrabh/compact-adviser/main/docs/eval-usage-floor-curve.png)

The judgment-eval harness lives in [packages/pi-extension/eval/](https://github.com/sowrabh/compact-adviser/blob/main/packages/pi-extension/eval/README.md). It is not a published dataset: point it at your own sessions and keep transcripts local.
