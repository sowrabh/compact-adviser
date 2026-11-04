import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  autoConfirmed,
  type Config,
  ConfigStore,
  DEFAULT_CONFIG,
  type Mode,
  parseBudget,
  parseJudge,
  parseMinimum,
  parseSavedApiKey,
  SAVED_KEY,
  selectedJudge,
} from "./config.ts";
import { snapshot } from "./context.ts";
import { DISABLE_ENV, disabledByEnv } from "./disable.ts";
import { formatKeyStatus, type ResolvedApiKey, resolveApiKey } from "./env.ts";
import { idleDelayMs, piCacheTtl } from "./idle.ts";
import {
  API_KEY_ENV,
  contextPressure,
  DEFAULT_JUDGE,
  decide,
  decisionsRequestBody,
  effectiveBudget,
  floorFor,
  idleFloor,
  JudgeError,
  type JudgeName,
  judge,
  judgeUnavailableMessage,
  qualifies,
  requestBody,
  score,
  typesafeEndpoint,
  type Verdict,
} from "./judge.ts";
import { promptSecret } from "./key-input.ts";
import { appendErrorLog, appendRequestLog, appendResponseLog, requestLogPath } from "./log.ts";
import { promptMinimum } from "./minimum-input.ts";
import { type JudgeProfile, parseProfile } from "./profile.ts";
import {
  cooldownReason,
  initialState,
  lastResponse,
  restoreState,
  type SessionState,
  STATE_TYPE,
} from "./state.ts";

const LABEL = "compact-adviser";
const HINT = "Compact adviser: work appears completed or recorded. Run /compact to save tokens.";
const USAGE =
  "Use /compact-adviser, auto, hint, off, status, judge <decisions|jev>, threshold <tokens|default>, budget <tokens|off>, snooze or dismiss.";
interface Options {
  agentDir: string;
  version: string;
  key?: () => string | undefined;
  now?: () => number;
  /** Runs `fn` after `ms`; returns a cancel. Tests drive it instead of real time. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  evaluate?: (
    state: unknown,
    key: string,
    signal: AbortSignal,
    profile: JudgeProfile | undefined,
    judge: JudgeName,
  ) => Promise<Verdict>;
}
function savedApiKey(store: ConfigStore, judge: JudgeName): string | undefined {
  try {
    return store.read()[SAVED_KEY[judge].field];
  } catch {
    return undefined;
  }
}
function currentJudge(store: ConfigStore): JudgeName {
  try {
    return selectedJudge(store.read());
  } catch {
    return DEFAULT_JUDGE;
  }
}
export function installAdviser(pi: ExtensionAPI, options: Options): void {
  // `COMPACT_ADVISER_DISABLE` is read once per install: a session's environment is fixed,
  // and re-reading it per event would only invite a mid-session half-disabled state.
  if (disabledByEnv(process.env[DISABLE_ENV])) return;
  const store = new ConfigStore(options.agentDir);
  /** The selected judge's key: launch environment, then the saved key, then the cwd `.env`. */
  const resolvedKey = (
    cwd = process.cwd(),
    judgeName: JudgeName = currentJudge(store),
  ): ResolvedApiKey => {
    if (options.key) {
      const value = options.key();
      return value !== undefined && value.trim() !== ""
        ? { value, source: "env" }
        : { value: undefined, source: "missing" };
    }
    return resolveApiKey(API_KEY_ENV[judgeName], process.env, cwd, savedApiKey(store, judgeName));
  };
  const key = (cwd?: string, judgeName?: JudgeName) => resolvedKey(cwd, judgeName).value;
  const now = options.now ?? Date.now;
  const evaluate =
    options.evaluate ??
    ((state, key, signal, profile, judgeName): Promise<Verdict> => {
      if (judgeName === "decisions") return decide(state, key, signal);
      const endpoint = typesafeEndpoint(process.env.TYPESAFE_BASE);
      if (endpoint === undefined) return Promise.reject(new JudgeError("configuration"));
      return judge(state, key, signal, undefined, undefined, profile, endpoint);
    });
  const [major, minor] = options.version.split(".").map(Number);
  const supported = Number.isFinite(major) && (major > 0 || minor >= 82);
  let generation = 0;
  let lifetime = 0;
  let request: AbortController | undefined;
  let compacting = false;
  let automaticCompaction = false;
  let hintVisible = false;
  let diagnostic = "";
  // The walk-away plan for the latest settled answer: armed at its turn end, dropped at any
  // sign of the person, and fired once just before the prompt cache would lapse.
  let away:
    | { seq: number; generation: number; lifetime: number; score?: number; cancel: () => void }
    | undefined;
  let awaySeq = 0;
  let stopTyping: (() => void) | undefined;
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  function cancelAway() {
    away?.cancel();
    away = undefined;
  }
  const active = (ctx: ExtensionContext) => ctx.mode === "tui" && ctx.hasUI;
  function persist(state: SessionState) {
    pi.appendEntry(STATE_TYPE, state);
  }
  function clearStatus(ctx: ExtensionContext) {
    if (active(ctx)) ctx.ui.setStatus(LABEL, undefined);
  }
  function notice(ctx: ExtensionContext, message: string) {
    if (!active(ctx) || diagnostic === message) return;
    diagnostic = message;
    ctx.ui.notify(message, "warning");
  }
  function refresh(ctx: ExtensionContext) {
    try {
      store.read();
    } catch {
      notice(ctx, "Cannot read compact-adviser settings; automatic action is disabled.");
    }
  }
  function invalidate(ctx: ExtensionContext) {
    cancelAway();
    generation++;
    request?.abort();
    request = undefined;
    if (hintVisible && active(ctx)) ctx.ui.setWidget(LABEL, undefined);
    hintVisible = false;
  }
  function eligible(ctx: ExtensionContext, c: Config, s: SessionState): number | undefined {
    const usage = ctx.getContextUsage();
    if (
      !supported ||
      !ctx.model ||
      !active(ctx) ||
      compacting ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages() ||
      ctx.ui.getEditorText?.().trim() ||
      c.mode === "off" ||
      !key(ctx.cwd, selectedJudge(c))?.trim() ||
      !usage ||
      usage.tokens === null ||
      !Number.isFinite(usage.tokens) ||
      !Number.isFinite(usage.contextWindow) ||
      usage.contextWindow <= 0 ||
      usage.tokens < c.minContextTokens ||
      cooldownReason(s, usage.tokens, now())
    )
      return undefined;
    return usage.tokens;
  }
  /** Context tokens over the budget or the model's window; NaN when unknown (strictest floor). */
  function usageFraction(ctx: ExtensionContext, c: Config): number {
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null) return Number.NaN;
    return contextPressure(usage.tokens, usage.contextWindow, c.contextBudgetTokens);
  }
  function sessionIdentity(ctx: ExtensionContext) {
    return JSON.stringify([
      ctx.sessionManager.getSessionId(),
      ctx.sessionManager.getLeafId(),
      ctx.model?.provider,
      ctx.model?.id,
    ]);
  }
  function startCompaction(ctx: ExtensionContext, when: "checkpoint" | "away") {
    compacting = true;
    automaticCompaction = true;
    const owner = lifetime;
    ctx.ui.notify(
      when === "away"
        ? "Compact adviser: compacting while you are away (experimental auto)."
        : "Compact adviser: compacting at a checkpoint (experimental auto).",
      "info",
    );
    ctx.compact({
      onComplete: () => {
        if (lifetime !== owner) return;
        compacting = false;
        automaticCompaction = false;
        // session_compact owns the successful checkpoint reset, including native compactions.
        refresh(ctx);
        ctx.ui.notify("Compact adviser: compaction completed.", "info");
      },
      onError: () => {
        if (lifetime !== owner) return;
        compacting = false;
        automaticCompaction = false;
        const latestState = restoreState(ctx.sessionManager.getBranch());
        persist({ ...latestState, retryAfter: now() + 60000 });
        notice(
          ctx,
          "Compaction failed or was cancelled. No immediate retry; Pi remains in control.",
        );
      },
    });
  }
  /** Arms the walk-away decision for the answer that just settled, in confirmed auto only. */
  function armAway(ctx: ExtensionContext, config: Config) {
    cancelAway();
    if (config.mode !== "auto" || !autoConfirmed(config)) return;
    const seq = ++awaySeq;
    const delay = idleDelayMs(
      piCacheTtl(ctx.model?.api, process.env.PI_CACHE_RETENTION),
      config.idleMinutes ?? 0,
    );
    away = { seq, generation, lifetime, cancel: setTimer(() => onAway(ctx, seq), delay) };
  }
  /**
   * The idle point: the person has been away since the answer settled. A turn-end score at or
   * above the schedule's loosest floor compacts once; anything else, including no judgment,
   * leaves context alone.
   */
  function onAway(ctx: ExtensionContext, seq: number) {
    const plan = away;
    if (plan?.seq !== seq || plan.generation !== generation || plan.lifetime !== lifetime) return;
    away = undefined;
    let config: Config;
    try {
      config = store.read();
    } catch {
      return;
    }
    if (config.mode !== "auto" || !autoConfirmed(config) || plan.score === undefined) return;
    if (eligible(ctx, config, restoreState(ctx.sessionManager.getBranch())) === undefined) return;
    const judgeName = selectedJudge(config);
    if (plan.score < idleFloor(parseProfile(config.profile, judgeName), judgeName)) return;
    startCompaction(ctx, "away");
  }
  async function settled(ctx: ExtensionContext) {
    if (!active(ctx)) return;
    let state = restoreState(ctx.sessionManager.getBranch());
    const last = lastResponse(ctx.sessionManager.getBranch());
    if (last?.message.stopReason !== "stop" || state.lastSettled === last.id) return;
    state = { ...state, lastSettled: last.id, completed: state.completed + 1 };
    const tokens = ctx.getContextUsage()?.tokens;
    if (
      state.compactionId &&
      state.baseline === null &&
      typeof tokens === "number" &&
      Number.isFinite(tokens)
    )
      state.baseline = tokens;
    persist(state);
    let config: Config;
    try {
      config = store.read();
    } catch {
      refresh(ctx);
      return;
    }
    armAway(ctx, config);
    if (request || eligible(ctx, config, state) === undefined) return;
    const judgeName = selectedJudge(config);
    const profile = parseProfile(config.profile, judgeName);
    // Both judges' keys are scrubbed, so neither provider ever receives the other's.
    const view = snapshot(ctx, [
      key(ctx.cwd, judgeName),
      key(ctx.cwd, judgeName === "decisions" ? "jev" : "decisions"),
      process.env.OPENAI_DECISIONS_API_KEY,
      process.env.TYPESAFE_API_KEY,
      savedApiKey(store, "decisions"),
      savedApiKey(store, "jev"),
    ]);
    if (view.conversationTokens <= 20000 || view.checkpointKey === state.lastHintKey) return;
    const body = () =>
      judgeName === "decisions"
        ? decisionsRequestBody(view.state)
        : requestBody(view.state, profile);
    let loggedBody: string | undefined;
    if (config.logRequests) {
      try {
        loggedBody = body();
        appendRequestLog(options.agentDir, loggedBody);
      } catch {
        // Request logging must not replace or delay the judgment.
      }
    }
    const controller = new AbortController();
    request = controller;
    const epoch = generation,
      identity = sessionIdentity(ctx),
      configIdentity = JSON.stringify(config);
    const current = () =>
      !controller.signal.aborted && generation === epoch && sessionIdentity(ctx) === identity;
    try {
      const result = await evaluate(
        view.state,
        key(ctx.cwd, judgeName)?.trim() ?? "",
        controller.signal,
        profile,
        judgeName,
      );
      if (!current()) return;
      if (config.logRequests) {
        try {
          appendResponseLog(
            options.agentDir,
            loggedBody ?? body(),
            result,
            usageFraction(ctx, config),
            profile,
            effectiveBudget(
              ctx.getContextUsage()?.contextWindow ?? Number.NaN,
              config.contextBudgetTokens,
            ),
          );
        } catch {
          // Response logging must not replace the gate decision.
        }
      }
      // No await between this final cross-session configuration/state check and compact().
      const latest = store.read();
      if (JSON.stringify(latest) !== configIdentity || eligible(ctx, latest, state) === undefined)
        return;
      state = { ...state, failures: 0, retryAfter: 0 };
      const auto = latest.mode === "auto";
      if (!qualifies(result, usageFraction(ctx, latest), profile)) {
        // Not this checkpoint's moment; the walk-away decision weighs the same score later.
        if (away?.generation === epoch) away.score = score(result, profile);
        persist(state);
        return;
      }
      if (auto && !autoConfirmed(latest)) {
        persist(state);
        return;
      }
      diagnostic = "";
      if (!auto) {
        state = { ...state, lastHintAt: state.completed, lastHintKey: view.checkpointKey };
        persist(state);
        ctx.ui.setWidget(LABEL, (_tui, theme) => new Text(theme.fg("warning", HINT), 0, 0));
        hintVisible = true;
      } else {
        startCompaction(ctx, "checkpoint");
      }
    } catch (error) {
      if (!current()) return;
      if (config.logRequests) {
        try {
          appendErrorLog(options.agentDir, error, loggedBody);
        } catch {
          // Error logging must not replace backoff.
        }
      }
      const failures = Math.min(state.failures + 1, 6);
      persist({ ...state, failures, retryAfter: now() + Math.min(300000, 5000 * 2 ** failures) });
      notice(
        ctx,
        error instanceof Error && error.name === "JudgeError"
          ? error.message
          : judgeUnavailableMessage(judgeName),
      );
    } finally {
      if (request === controller) request = undefined;
    }
  }
  pi.on("turn_end", (_event, ctx) => {
    if (!ctx.isIdle() && hintVisible) invalidate(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    void settled(ctx).catch(() =>
      notice(ctx, "Compact adviser could not inspect this checkpoint; context left unchanged."),
    );
  });
  pi.on("session_start", (_event, ctx) => {
    lifetime++;
    invalidate(ctx);
    stopTyping?.();
    // Raw keys mean the person is at the keyboard: drop a pending walk-away decision. Never
    // consumes the input.
    stopTyping = active(ctx)
      ? ctx.ui.onTerminalInput?.(() => {
          cancelAway();
          return undefined;
        })
      : undefined;
    compacting = false;
    automaticCompaction = false;
    clearStatus(ctx);
    refresh(ctx);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    invalidate(ctx);
    compacting = false;
    automaticCompaction = false;
  });
  pi.on("input", (_event, ctx) => {
    invalidate(ctx);
  });
  pi.on("session_before_compact", (event, ctx) => {
    invalidate(ctx);
    compacting = true;
    // The judgment assumes Pi's ordinary recent tail. Inspect the native
    // preparation, not duplicated settings-file discovery, before summarization.
    if (automaticCompaction && event.preparation.settings.keepRecentTokens < 20000) {
      notice(
        ctx,
        "Automatic compaction skipped: Pi is configured to retain less than 20k recent tokens. Use /compact manually if appropriate.",
      );
      return { cancel: true };
    }
  });
  pi.on("session_compact", (event, ctx) => {
    if (!active(ctx)) return;
    invalidate(ctx);
    compacting = false;
    automaticCompaction = false;
    persist(initialState(event.compactionEntry.id));
    refresh(ctx);
  });
  pi.on("session_before_switch", (_event, ctx) => {
    lifetime++;
    invalidate(ctx);
  });
  pi.on("session_before_fork", (_event, ctx) => {
    lifetime++;
    invalidate(ctx);
  });
  pi.on("session_before_tree", (_event, ctx) => {
    lifetime++;
    invalidate(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    invalidate(ctx);
    compacting = false;
    automaticCompaction = false;
    refresh(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    invalidate(ctx);
    const s = restoreState(ctx.sessionManager.getBranch());
    if (active(ctx) && s.compactionId) persist({ ...s, baseline: null });
    refresh(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    lifetime++;
    invalidate(ctx);
    stopTyping?.();
    stopTyping = undefined;
    compacting = false;
    automaticCompaction = false;
    clearStatus(ctx);
  });

  function save(ctx: ExtensionContext, patch: Partial<Config>, message: string) {
    invalidate(ctx);
    store.update(patch);
    diagnostic = "";
    ctx.ui.notify(message, "info");
  }
  async function changeMode(ctx: ExtensionCommandContext, mode: Mode) {
    if (mode === "auto") {
      if (!supported) throw new Error("Automatic mode requires Pi 0.82.0 or newer.");
      if (!autoConfirmed(store.read())) {
        if (
          !(await ctx.ui.confirm(
            "Enable experimental automatic compaction?",
            "This persists across all Pi sessions and projects. Compaction is lossy and timing accuracy is not proven. It acts at eligible checkpoints, and when you walk away from a settled answer it compacts a finished session just before its prompt cache lapses. It does not compact immediately.",
          ))
        )
          return;
      }
      save(
        ctx,
        { mode, autoAcknowledged: true, consentVersion: 2 },
        `Automatic mode saved (all sessions). ${currentJudge(store) === "decisions" ? "An OpenAI" : "A TypeSafe"} key is still required.`,
      );
    } else
      save(
        ctx,
        { mode },
        `${mode === "hint" ? "Hints only" : "Off"} saved (all sessions). Pi's built-in compaction is unchanged.`,
      );
  }
  function minimum(ctx: ExtensionCommandContext, text: string) {
    const count = text === "default" ? DEFAULT_CONFIG.minContextTokens : parseMinimum(text);
    save(
      ctx,
      { minContextTokens: count },
      `Minimum context saved: ${count.toLocaleString("en-US")} tokens (all sessions).`,
    );
    if (ctx.model && count >= ctx.model.contextWindow)
      ctx.ui.notify(
        "This minimum is at or above the active model's context window. Opportunistic advice will not trigger before native compaction.",
        "warning",
      );
  }
  function budget(ctx: ExtensionCommandContext, text: string) {
    const count = parseBudget(text);
    save(
      ctx,
      { contextBudgetTokens: count },
      count > 0
        ? `Context budget saved: ${count.toLocaleString("en-US")} tokens (all sessions).`
        : "Context budget off (all sessions): the hint floor follows the model's window.",
    );
  }
  function changeJudge(ctx: ExtensionCommandContext, text: string) {
    const judgeName = parseJudge(text);
    save(
      ctx,
      { judge: judgeName },
      judgeName === "decisions"
        ? "Judge saved: OpenAI Decisions (all sessions). It reads OPENAI_DECISIONS_API_KEY or a saved OpenAI key."
        : "Judge saved: TypeSafe Jev (all sessions). It reads TYPESAFE_API_KEY or a saved TypeSafe key.",
    );
  }
  function status(ctx: ExtensionCommandContext) {
    const c = store.read(),
      judgeName = selectedJudge(c),
      s = restoreState(ctx.sessionManager.getBranch()),
      usage = ctx.getContextUsage(),
      t = usage?.tokens,
      u = usageFraction(ctx, c);
    ctx.ui.notify(
      `Mode: ${c.mode}. Judge: ${judgeName}. Minimum: ${c.minContextTokens.toLocaleString("en-US")} tokens. Budget: ${c.contextBudgetTokens > 0 ? `${c.contextBudgetTokens.toLocaleString("en-US")} tokens` : "off"}. Context: ${t ?? "unknown"}${Number.isFinite(u) ? ` (${Math.round(u * 100)}% of the ${effectiveBudget(usage?.contextWindow ?? Number.NaN, c.contextBudgetTokens) > 0 ? "budget" : "window"}; hint floor ${floorFor(u, parseProfile(c.profile, judgeName), judgeName).toFixed(2)})` : ""}. ${formatKeyStatus(resolvedKey(ctx.cwd, judgeName).source)}. ${typeof t === "number" ? `${cooldownReason(s, t, now()) ?? "No cooldown; semantic checks still apply"}.` : "Waiting for fresh model usage."} Request log: ${c.logRequests ? requestLogPath(options.agentDir) : "off"}. Settings: ${store.path}`,
      "info",
    );
  }
  const company = (judgeName: JudgeName) => (judgeName === "decisions" ? "OpenAI" : "TypeSafe");
  async function changeLogRequests(ctx: ExtensionCommandContext, enabled: boolean) {
    const name = company(currentJudge(store));
    save(
      ctx,
      { logRequests: enabled },
      enabled
        ? `${name} request logging on (all sessions). ${requestLogPath(options.agentDir)}`
        : `${name} request logging off (all sessions).`,
    );
  }
  function changeSavedApiKey(ctx: ExtensionCommandContext, text: string, judgeName: JudgeName) {
    const { field, label } = SAVED_KEY[judgeName];
    save(
      ctx,
      { [field]: parseSavedApiKey(text, judgeName) },
      `${label} saved (all sessions). Status shows the source, never the value.`,
    );
  }
  function clearSavedApiKey(ctx: ExtensionCommandContext, judgeName: JudgeName) {
    const { field, label } = SAVED_KEY[judgeName];
    save(
      ctx,
      { [field]: "" },
      `Saved ${label} cleared (all sessions). Launch environment and .env still apply.`,
    );
  }
  async function menu(ctx: ExtensionCommandContext) {
    while (true) {
      const c = store.read();
      const judgeName = selectedJudge(c);
      const { field, label } = SAVED_KEY[judgeName];
      const keyLabel = `${label}: ${c[field] ? "saved" : "not saved"}`;
      const judgeLabel = `Judge: ${judgeName === "decisions" ? "OpenAI Decisions" : "TypeSafe Jev"}`;
      const labels = [
        `Mode: ${c.mode}`,
        `Minimum context: ${c.minContextTokens.toLocaleString("en-US")} tokens`,
        `Log ${company(judgeName)} requests: ${c.logRequests ? "on" : "off"}`,
        keyLabel,
        judgeLabel,
        "Reset minimum to 40,000",
        "Status",
        "Close",
      ];
      const selected = await ctx.ui.select("Compact adviser (saved for all sessions)", labels);
      if (!selected || selected === "Close") return;
      if (selected === labels[0]) {
        const mode = await ctx.ui.select("Mode", [
          "Hints only (default)",
          "Automatic (experimental)",
          "Off",
        ]);
        if (mode)
          await changeMode(
            ctx,
            mode.startsWith("Hints") ? "hint" : mode.startsWith("Automatic") ? "auto" : "off",
          );
      } else if (selected === labels[1]) {
        while (true) {
          const input = await promptMinimum(ctx, store.read().minContextTokens);
          if (input === undefined) break;
          try {
            minimum(ctx, input);
            break;
          } catch (error) {
            ctx.ui.notify(
              error instanceof Error ? error.message : "Could not save minimum.",
              "error",
            );
          }
        }
      } else if (selected === labels[2]) {
        const logging = await ctx.ui.select(`Log ${company(judgeName)} requests`, [
          "Off (default)",
          "On",
        ]);
        if (logging) await changeLogRequests(ctx, logging.startsWith("On"));
      } else if (selected === keyLabel) {
        const actions = c[field] ? ["Set key", "Clear saved key"] : ["Set key"];
        const action = await ctx.ui.select(label, actions);
        if (action === "Clear saved key") clearSavedApiKey(ctx, judgeName);
        else if (action === "Set key") {
          while (true) {
            const input = await promptSecret(ctx, label);
            if (input === undefined) break;
            try {
              changeSavedApiKey(ctx, input, judgeName);
              break;
            } catch (error) {
              ctx.ui.notify(
                error instanceof Error ? error.message : `Could not save the ${label}.`,
                "error",
              );
            }
          }
        }
      } else if (selected === judgeLabel) {
        const choice = await ctx.ui.select("Judge", ["OpenAI Decisions (default)", "TypeSafe Jev"]);
        if (choice) changeJudge(ctx, choice.startsWith("OpenAI") ? "decisions" : "jev");
      } else if (selected === labels[5]) minimum(ctx, "default");
      else status(ctx);
    }
  }
  pi.registerCommand("compact-adviser", {
    description: "Configure persistent compaction advice, experimental auto, and token minimum",
    getArgumentCompletions: (prefix) =>
      [
        "auto",
        "hint",
        "off",
        "status",
        "judge decisions",
        "judge jev",
        "threshold ",
        "threshold default",
        "budget ",
        "budget off",
        "snooze",
        "dismiss",
      ]
        .filter((v) => v.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (!active(ctx)) return;
      try {
        const [command, ...rest] = args.trim().split(/\s+/);
        const value = rest.join(" ");
        if (!command) await menu(ctx);
        else if (["auto", "hint", "off"].includes(command) && !value)
          await changeMode(ctx, command as Mode);
        else if (command === "judge" && value) changeJudge(ctx, value);
        else if (command === "threshold" && value) minimum(ctx, value);
        else if (command === "budget" && value) budget(ctx, value);
        else if (command === "status" && !value) status(ctx);
        else if (["snooze", "dismiss"].includes(command) && !value) {
          const s = restoreState(ctx.sessionManager.getBranch());
          invalidate(ctx);
          persist({ ...s, snoozeUntil: command === "snooze" ? s.completed + 4 : s.snoozeUntil });
          ctx.ui.notify(
            command === "snooze"
              ? "Advice snoozed for three completed exchanges."
              : "Hint dismissed.",
            "info",
          );
        } else throw new Error(USAGE);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Could not save settings.", "error");
      }
    },
  });
}
