# Security and verification boundaries

## Conversation data

The Pi extension, Claude Code mod, Codex plugin, and Grok Build plugin send selected conversation text to the selected judge when the package is installed, that judge's key is available from the launch environment, saved settings, or a `.env` file in the working directory, and the other product gates pass (mode, minimum context, idle session). The `judge` setting picks it: `decisions` (the default) sends to OpenAI's Decisions API with `OPENAI_DECISIONS_API_KEY`; `jev` sends to TypeSafe with `TYPESAFE_API_KEY`. Only the selected judge is asked, and its key never goes to the other provider.
Installing the package is that consent; there is no separate sharing toggle.
With `TYPESAFE_BASE` set in the launch environment, the same request and key go to `<TYPESAFE_BASE>/v1/systemone` instead. The plugin never reads it from saved settings or a working-directory `.env`; a host's own trusted project configuration can still set environment variables, as it can already run hooks. The base must be `https`, or plain `http` only on a loopback host (`127.0.0.1`, `[::1]`, `localhost`), so the key never crosses the network in cleartext; any other value, or one with credentials, a query or a fragment, means no request and no advice.
Pi and Claude Code can save a key from their settings UI. Codex uses an external settings CLI. Grok can save one only through the shell CLI outside Grok, because Grok appends slash-command arguments to the model. A saved key lives with mode and threshold in the implementation's settings store, with file permissions as restrictive as the host allows.
It is never shown after save, and never written to logs, status lines, error messages, or TypeSafe request bodies, including when the agent reads the settings file.

| Sent to `https://api.openai.com/v1/decisions` (`decisions`) or `https://api.typesafe.ai/v1/systemone` (`jev`) | Not sent |
| --- | --- |
| Bounded user constraints, up to the last 64 visible replies and tool results (clipped), short tool-result excerpts, an existing summary, saved-artifact names, omission markers | System prompts, hidden reasoning, images, environment variables, the API key in the model context and request body, complete transcripts |

Redaction of known key patterns and obvious sensitive-file results is best-effort, not a guarantee; do not keep this package loaded for material that must not leave the machine.
Requests are capped at 32,000 serialized UTF-8 bytes.
The API key never enters the model context or the request body; it is sent as the Authorization header to authenticate the call. A saved OpenAI key is hidden from Claude Code's `/config` like the TypeSafe one, and both saved-key fields are redacted from snapshots.
Errors, timeouts, malformed responses, refusals, and contradictory factors never substitute an affirmative judgment.
OpenAI keeps API inputs for up to 30 days for abuse monitoring unless the account has Zero Data Retention, and does not train on API data by default.

Keep-warm (Claude Code, confirmed automatic mode only) sends nothing to either judge. When the person has walked away from an unfinished session, it replays the session's own last request to Anthropic through Claude Code's `$.model.fork`, with one added line (`Reply with exactly: OK`), on the person's model quota. The request and the reply stay out of the transcript, and warming stops at `keepWarmHours`, on a cache miss, on a failed fork, or at any sign of the person.

Automatic compaction on Pi and Claude Code is experimental and lossy, and it now also acts once the person has walked away; Codex and Grok are hint-only because an outside process cannot trigger `/compact` in their running sessions. An automatic-mode acknowledgement saved before walk-away compaction existed does not count; auto asks again.
A high model probability is not proof of preservation or continuation quality.
Hint mode is the default; the host's own compaction path and other extensions' hooks remain authoritative.

## Package separation

The Pi implementation lives only in `packages/pi-extension` and owns its Pi-specific configuration and session entries.
The Claude Code implementation lives only in `packages/claude-mod` and owns its `userConfig` options and plugin store.
The Codex implementation lives only in `packages/codex-plugin` and owns its settings, session records, and request logs under `<CODEX_HOME>/compact-adviser/`.
The Grok implementation lives only in `packages/grok-plugin` and owns its settings, per-session state, verdicts, diagnostics, and request logs under `${GROK_HOME:-~/.grok}/compact-adviser/`.
No implementation loads another's runtime or reads another's storage.

## Verified hosts

Upstream verified on 2026-09-17 against the actual **Pi 0.85.1**, **Claude Code 2.1.275**, **Codex CLI 0.153.4**, and **Grok Build 1.0.34** host runtimes. This fork re-ran the Claude Code live suite on **Claude Code 2.1.318** and the Pi live suite on **Pi 0.85.1** on 2026-11-04; walk-away compaction and keep-warm need Claude Code 2.1.317 or newer.
The Pi extension API floor remains 0.82.0; the Claude Code mods API is early access and default-off; the Codex plugin requires Node 22.18 or newer and Codex CLI 0.153.0 or newer, and is supported on macOS and Linux. The Grok adapter requires Node 22.18 or newer.
The Claude Code module is a complete no-op unless `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is exactly `1`.
Requests from the mod go through Claude Code's host fetch (`$.http.fetch`), which does not expose redirect control to plugins; the endpoint is `https://api.openai.com/v1/decisions` for `decisions`, and `https://api.typesafe.ai/v1/systemone` for `jev` unless `TYPESAFE_BASE` replaces its base. `TYPESAFE_BASE` never redirects Decisions requests.
Codex requests use Node's `fetch` from the hook process.
Besides `TYPESAFE_BASE`, the only endpoint override, `COMPACT_ADVISER_TEST_ENDPOINT`, exists for the live regressions and is ignored unless it is an `http://127.0.0.1:<port>/` URL.
The automatic-mode acknowledgement is kept in the plugin's own store, not in `/config`, so experimental auto cannot be granted without the disclosure dialog. A legacy `sharingConsent` field in that store is ignored.

The Pi client rejects redirects from the TypeSafe endpoint. The Grok plugin uses Node's built-in fetch against that endpoint.
The user's Pi, Claude Code, Codex, or Grok installation is independently managed.

## Development SDK

The Pi package's development SDK is pinned to **Pi 0.85.1**, matching the verified runtime.
At verification on 2026-09-17, `npm audit` in `packages/pi-extension` reported 0 vulnerabilities.
The Claude Code mod, Codex plugin, and Grok plugin have no runtime dependencies; their development dependencies are limited to type-checking, linting, and Node type definitions.

Install Pi runtime dependencies with `--omit=dev --omit=peer` when using Pi's bundled modules.
The user's Pi provides the core modules at runtime; this repository does not bundle or update that shared installation.
Development dependencies can be revisited when upgrading the supported API baseline, with real-runtime compatibility tests kept green.

## Tests versus model accuracy

The native integration tests use the real Pi executable, Claude Code TUI, Codex TUI, or Grok agent, isolated configuration directories, and deterministic provider and TypeSafe fixtures.
They prove API/UI integration, cancellation, and local safety conditions without exposing account credentials or conversation data.
They do not establish live judge precision (Jev's or Decisions') or continued task quality after a real generated summary.
