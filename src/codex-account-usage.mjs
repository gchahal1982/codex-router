import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

import { findCodexBinary } from "./codex-binary.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";

const DEFAULT_TIMEOUT_MS = 10_000;

// This used to keep its own two-line search -- an undocumented CODEX_BINARY
// override, a hardcoded macOS app path, then the bare name "codex". None of
// the three finds a Windows install: the bundled Desktop CLI lives under a
// version-hashed %LOCALAPPDATA% directory, and a bare "codex" resolves to the
// extensionless npm shim that Node cannot spawn. The panel reported "the Codex
// app-server could not be started" on every Windows machine. Use the same
// discovery the rest of the router uses, and keep CODEX_BINARY working for
// anyone who set it.
function codexBinary() {
  return process.env.CODEX_BINARY || findCodexBinary();
}

// Killing a child that was reached through cmd.exe kills the shell, not the
// app-server behind it. On a timeout that left a Codex process holding the
// pipe for as long as the session lived, once per poll.
function killProcessTree(child, viaShell) {
  if (!viaShell || process.platform !== "win32" || !child.pid) {
    child.kill();
    return;
  }
  try {
    execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    child.kill();
  }
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function normalizeWindow(window) {
  if (!window || typeof window !== "object") return null;
  const usedPercent = clampPercent(window.usedPercent);
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowDurationMins: Number.isFinite(window.windowDurationMins)
      ? window.windowDurationMins
      : null,
    resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt : null,
  };
}

// The app-server reports banked one-off resets separately from the rolling
// quota windows: `rateLimitResetCredits` lists the credits that can be spent to
// clear a limit right now. Keep only the count and the redeemable ids -- the
// `credits.balance` money value stays out of the router snapshot.
function normalizeResetCredits(rateLimitResponse) {
  const source = rateLimitResponse?.rateLimitResetCredits;
  const rows = Array.isArray(source?.credits) ? source.credits : [];
  const credits = rows
    .map((credit) => ({
      id: typeof credit?.id === "string" ? credit.id : null,
      status: typeof credit?.status === "string" ? credit.status : null,
      limitId: typeof credit?.limitId === "string" ? credit.limitId : null,
    }))
    .filter((credit) => credit.id || credit.status);
  const reported = Number(source?.availableCount);
  const availableCount = Number.isFinite(reported)
    ? Math.max(0, Math.trunc(reported))
    : credits.filter((credit) => credit.status === "available").length;
  return { availableCount, credits };
}

function optionalTokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : undefined;
}

export function normalizeCodexAccountUsage(rateLimitResponse, usageResponse, now = new Date()) {
  const buckets = Array.isArray(usageResponse?.dailyUsageBuckets)
    ? usageResponse.dailyUsageBuckets
        .filter(
          (bucket) =>
            typeof bucket?.startDate === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(bucket.startDate) &&
            Number.isFinite(bucket.tokens),
        )
        .map((bucket) => ({
          startDate: bucket.startDate,
          tokens: Math.max(0, Math.trunc(bucket.tokens)),
          ...(optionalTokenCount(bucket.inputTokens) !== undefined
            ? { inputTokens: optionalTokenCount(bucket.inputTokens) }
            : {}),
          ...(optionalTokenCount(bucket.cachedInputTokens) !== undefined
            ? { cachedInputTokens: optionalTokenCount(bucket.cachedInputTokens) }
            : {}),
          ...(optionalTokenCount(bucket.outputTokens) !== undefined
            ? { outputTokens: optionalTokenCount(bucket.outputTokens) }
            : {}),
        }))
        .sort((left, right) => left.startDate.localeCompare(right.startDate))
    : [];
  const limits = rateLimitResponse?.rateLimits || {};
  const summary = usageResponse?.summary || {};
  return {
    fetchedAt: now.toISOString(),
    planType: typeof limits.planType === "string" ? limits.planType : null,
    limitId: typeof limits.limitId === "string" ? limits.limitId : null,
    primary: normalizeWindow(limits.primary),
    secondary: normalizeWindow(limits.secondary),
    resetCredits: normalizeResetCredits(rateLimitResponse),
    dailyUsageBuckets: buckets,
    summary: {
      lifetimeTokens: Number.isFinite(summary.lifetimeTokens) ? summary.lifetimeTokens : null,
      peakDailyTokens: Number.isFinite(summary.peakDailyTokens) ? summary.peakDailyTokens : null,
      currentStreakDays: Number.isFinite(summary.currentStreakDays)
        ? summary.currentStreakDays
        : null,
    },
  };
}

export function classifyCodexQuotaWindows(usage) {
  const classified = { fiveHour: null, weekly: null, other: [] };
  for (const window of [usage?.primary, usage?.secondary]) {
    if (!window || !Number.isFinite(window.usedPercent)) continue;
    const entry = {
      usedPercent: window.usedPercent,
      remainingPercent: window.remainingPercent,
      windowDurationMins: window.windowDurationMins ?? null,
      resetsAt: window.resetsAt ?? null,
    };
    const kind = quotaWindowKind(window);
    if (kind === "fiveHour" && !classified.fiveHour) classified.fiveHour = entry;
    else if (kind === "weekly" && !classified.weekly) classified.weekly = entry;
    else classified.other.push(entry);
  }
  return classified;
}

function quotaWindowKind(window) {
  const mins = Number(window?.windowDurationMins);
  if (!Number.isFinite(mins) || mins <= 0) return null;
  if (mins === 300 || (mins >= 60 && mins % 60 === 0 && mins / 60 === 5)) return "fiveHour";
  if (mins === 10_080 || (mins >= 1_440 && mins % 1_440 === 0 && mins / 1_440 === 7)) return "weekly";
  return null;
}

// The rate-limit read and the banked-reset redeem both need the same thing: a
// short-lived app-server session bound to one account's CODEX_HOME. Keep the
// spawn, handshake, timeout, and process-tree teardown in one place so the
// redeem path inherits the same --no-discovery guard the poll already honors.
function withCodexAppServer({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  binary = codexBinary(),
  platform = process.platform,
  spawnImpl = spawn,
  env,
  codexHome,
  timeoutMessage = "Codex account request timed out.",
  onReady,
  onMessage,
}) {
  return new Promise((resolve, reject) => {
    // The app-server answers with the signed-in ChatGPT account's usage, which
    // makes this a live credential probe against the real CODEX_HOME -- the
    // same class of read codexAuthStatus() refuses. The tray polls this every
    // 30 seconds, so an unguarded spawn here would quietly break the
    // --no-discovery promise in the background.
    if (discoveryDisabled()) {
      reject(new Error("Credential discovery is disabled (--no-discovery); the Codex account is not read."));
      return;
    }
    if (!binary) {
      reject(new Error("The Codex app-server could not be started: no Codex binary was found."));
      return;
    }
    const target = spawnableCommand(binary, ["app-server"], platform);
    const childEnv = {
      ...process.env,
      ...(env && typeof env === "object" ? env : {}),
      ...(codexHome ? { CODEX_HOME: codexHome } : {}),
    };
    const processHandle = spawnImpl(target.command, target.args, {
      ...target.options,
      env: childEnv,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const lines = readline.createInterface({ input: processHandle.stdout });
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      killProcessTree(processHandle, Boolean(target.options.windowsVerbatimArguments));
      if (error) reject(error);
      else resolve(value);
    };
    const send = (message) => {
      processHandle.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const timer = setTimeout(() => finish(new Error(timeoutMessage)), timeoutMs);

    processHandle.once("error", () => {
      finish(new Error("The Codex app-server could not be started."));
    });
    processHandle.once("exit", (code) => {
      if (!settled) finish(new Error(`Codex app-server exited before replying (${code ?? "signal"}).`));
    });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 1) {
        if (message.error) {
          finish(new Error("Codex app-server initialization failed."));
          return;
        }
        send({ method: "initialized", params: {} });
        onReady({ send, finish });
        return;
      }
      onMessage({ message, send, finish });
    });

    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex_router_tray",
          title: "Codex Router Tray",
          version: "0.4.0",
        },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

export function readCodexAccountUsage(options = {}) {
  const responses = new Map();
  return withCodexAppServer({
    ...options,
    timeoutMessage: "Codex account usage request timed out.",
    onReady: ({ send }) => {
      send({ id: 2, method: "account/rateLimits/read", params: null });
      send({ id: 3, method: "account/usage/read", params: null });
    },
    onMessage: ({ message, finish }) => {
      if (message.id !== 2 && message.id !== 3) return;
      if (message.error) {
        if (message.id === 2) {
          finish(new Error("Codex account limits are unavailable for this login."));
          return;
        }
        responses.set(3, { summary: {}, dailyUsageBuckets: [] });
      } else {
        responses.set(message.id, message.result);
      }
      if (responses.size === 2) {
        finish(undefined, normalizeCodexAccountUsage(responses.get(2), responses.get(3)));
      }
    },
  });
}

// Spending a banked reset is a one-way action, so the app-server requires an
// idempotency key: a retry with the same key cannot burn a second credit.
export function consumeCodexRateLimitResetCredit({
  idempotencyKey = randomUUID(),
  ...options
} = {}) {
  return withCodexAppServer({
    ...options,
    timeoutMessage: "Codex banked reset request timed out.",
    onReady: ({ send }) => {
      send({
        id: 4,
        method: "account/rateLimitResetCredit/consume",
        params: { idempotencyKey },
      });
    },
    onMessage: ({ message, finish }) => {
      if (message.id !== 4) return;
      if (message.error) {
        finish(new Error(message.error.message || "The banked reset could not be redeemed."));
        return;
      }
      const outcome = typeof message.result?.outcome === "string" ? message.result.outcome : "unknown";
      finish(undefined, { outcome, idempotencyKey });
    },
  });
}
