import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { discoveryDisabled } from "./discovery-mode.mjs";
import { writePrivateJson } from "./file-security.mjs";
import {
  CHATGPT_ACCOUNTS_DIR,
  CHATGPT_RESERVE_CACHE_PATH,
  CHATGPT_RESERVE_STATE_PATH,
  CODEX_HOME,
} from "./paths.mjs";

// The Luna reserve allowance.
//
// Codex's own quota surface (`account/rateLimits/read`) does not report it: an
// account with a live reserve looks identical there to one without. It exists
// only on the `/wham/usage` HTTP endpoint, under `additional_rate_limits`, which
// is also what drives the app's "You're out of Codex and Work usage" banner.
//
// Measured against all six accounts on this machine: an account carries the
// allowance exactly when it has a `base_model_inference` limit bucket, and the
// entry names `gpt-5.6-luna` as the model it meters. Accounts that only ever
// used Codex have `additional_rate_limits: null` and no reserve to spend, which
// is why plan type alone cannot answer the question.
export const RESERVE_LIMIT_NAME = "gpt-reserve";
export const RESERVE_MODEL_SLUG = "gpt-5.6-luna";
export const DEFAULT_RESERVE_EFFORT = "medium";

const RESERVE_PROBE_TIMEOUT_MS = 10_000;
// Long enough that ordinary rotation never pays for a probe, short enough that a
// window that reset is noticed within a few turns.
export const RESERVE_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const EFFORTS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

function usageEndpoint() {
  const base = (
    process.env.MODEL_ROUTER_CHATGPT_BASE_URL || "https://chatgpt.com/backend-api"
  ).replace(/\/+$/, "");
  return `${base}/wham/usage`;
}

function authPathForAccount(accountId) {
  if (accountId === "default") return path.join(CODEX_HOME, "auth.json");
  if (!ACCOUNT_ID.test(accountId)) throw new Error("Invalid ChatGPT account id.");
  return path.join(CHATGPT_ACCOUNTS_DIR, accountId, "auth.json");
}

// Only the two fields the request needs. The refresh token and id token are
// never read, and no token value is returned to a caller.
function sessionForAccount(accountId) {
  const file = authPathForAccount(accountId);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const accessToken = parsed?.tokens?.access_token;
    const chatgptAccountId = parsed?.tokens?.account_id;
    if (typeof accessToken !== "string" || !accessToken) return undefined;
    return {
      accessToken,
      chatgptAccountId: typeof chatgptAccountId === "string" ? chatgptAccountId : "",
    };
  } catch {
    return undefined;
  }
}

export function reserveEntryFrom(payload) {
  const rows = Array.isArray(payload?.additional_rate_limits)
    ? payload.additional_rate_limits
    : [];
  return rows.find((row) => row?.limit_name === RESERVE_LIMIT_NAME);
}

// `allowed` is the field the Codex client itself tests before treating a reserve
// as usable, so it is the one this follows rather than deriving availability
// from a percentage.
export function normalizeReserve(payload) {
  const entry = reserveEntryFrom(payload);
  if (!entry) return { present: false, allowed: false };
  const window = entry.rate_limit?.primary_window;
  const usedPercent = Number(window?.used_percent);
  const resetAt = Number(window?.reset_at);
  return {
    present: true,
    allowed: entry.rate_limit?.allowed === true,
    ...(Number.isFinite(usedPercent)
      ? { usedPercent, remainingPercent: Math.max(0, 100 - usedPercent) }
      : {}),
    ...(Number.isFinite(resetAt) ? { resetAt } : {}),
    ...(typeof entry.normal_model_slug === "string"
      ? { modelSlug: entry.normal_model_slug }
      : {}),
    ...(typeof entry.metered_feature === "string"
      ? { meteredFeature: entry.metered_feature }
      : {}),
  };
}

export async function probeAccountReserve(accountId, { fetchImpl = fetch, timeoutMs = RESERVE_PROBE_TIMEOUT_MS } = {}) {
  if (discoveryDisabled()) {
    throw new Error("Credential discovery is disabled (--no-discovery); ChatGPT reserve is not read.");
  }
  const session = sessionForAccount(accountId);
  if (!session) return { present: false, allowed: false, error: "No usable session." };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(usageEndpoint(), {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        "ChatGPT-Account-Id": session.chatgptAccountId,
        "OAI-App-Brand": "codex",
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { present: false, allowed: false, error: `Usage endpoint returned ${response.status}.` };
    }
    return normalizeReserve(await response.json());
  } catch (error) {
    // A reserve that cannot be measured is treated as absent: rotating into an
    // account on an unverified guess would spend the wrong subscription.
    return {
      present: false,
      allowed: false,
      error: error?.name === "AbortError" ? "Reserve probe timed out." : "Reserve probe failed.",
    };
  } finally {
    clearTimeout(timer);
  }
}

function defaultState() {
  return { version: 1, enabled: false, effort: DEFAULT_RESERVE_EFFORT, accounts: [] };
}

export function readReserveSettings() {
  if (!existsSync(CHATGPT_RESERVE_STATE_PATH)) return defaultState();
  try {
    const parsed = JSON.parse(readFileSync(CHATGPT_RESERVE_STATE_PATH, "utf8"));
    if (parsed?.version !== 1 || typeof parsed.enabled !== "boolean") return defaultState();
    return {
      version: 1,
      enabled: parsed.enabled,
      effort: EFFORTS.includes(parsed.effort) ? parsed.effort : DEFAULT_RESERVE_EFFORT,
      accounts: Array.isArray(parsed.accounts)
        ? parsed.accounts.map((id) => String(id).trim()).filter((id) => ACCOUNT_ID.test(id))
        : [],
      ...(EFFORTS.includes(parsed.cronEffort) ? { cronEffort: parsed.cronEffort } : {}),
    };
  } catch {
    // An unreadable file means the feature is off, matching how the failover and
    // model-sync states fail closed.
    return defaultState();
  }
}

export function setReserveSettings({ enabled, effort, cronEffort, accounts } = {}) {
  const current = readReserveSettings();
  const next = { ...current };
  for (const [key, value] of [["effort", effort], ["cronEffort", cronEffort]]) {
    if (value === undefined) continue;
    const level = String(value).trim();
    if (!level || level === "default") {
      if (key === "cronEffort") delete next.cronEffort;
      else next.effort = DEFAULT_RESERVE_EFFORT;
      continue;
    }
    if (!EFFORTS.includes(level)) {
      throw new Error(`Reserve reasoning effort must be one of: default, ${EFFORTS.join(", ")}.`);
    }
    next[key] = level;
  }
  if (accounts !== undefined) {
    const list = (Array.isArray(accounts) ? accounts : String(accounts).split(","))
      .map((id) => String(id).trim())
      .filter(Boolean);
    for (const id of list) {
      if (!ACCOUNT_ID.test(id)) throw new Error(`Invalid ChatGPT account id: ${id}`);
    }
    next.accounts = [...new Set(list)];
  }
  if (enabled !== undefined) {
    if (enabled === true && !next.accounts.length) {
      throw new Error("Add at least one reserve account before enabling reserve rotation.");
    }
    next.enabled = enabled === true;
  }
  writePrivateJson(CHATGPT_RESERVE_STATE_PATH, { version: 1, ...next }, { directoryMode: 0o700 });
  return readReserveSettings();
}

// Every known account probed once, so an operator can see which logins actually
// carry the allowance instead of inferring it from plan type. Sequential on
// purpose: this is six authenticated requests against chatgpt.com, not a hot
// path, and a burst of parallel probes against one backend is rude.
export async function discoverReserveAccounts({
  accountIds,
  fetchImpl = fetch,
  labelById = new Map(),
} = {}) {
  const results = [];
  for (const id of accountIds || []) {
    const reserve = await probeAccountReserve(id, { fetchImpl });
    results.push({
      id,
      ...(labelById.get?.(id) ? { label: labelById.get(id) } : {}),
      ...reserve,
    });
  }
  return {
    fetchedAt: new Date().toISOString(),
    modelSlug: RESERVE_MODEL_SLUG,
    accounts: results,
    eligible: results.filter((entry) => entry.present && entry.allowed).map((entry) => entry.id),
  };
}

// Cached availability for the routing path. Rotation must never block a turn on
// six HTTP probes, so ordering reads this and a stale entry simply stops
// influencing the order.
export function reserveByIdFromCache(now = Date.now(), { maxAgeMs = RESERVE_CACHE_MAX_AGE_MS } = {}) {
  try {
    if (!existsSync(CHATGPT_RESERVE_CACHE_PATH)) return new Map();
    const parsed = JSON.parse(readFileSync(CHATGPT_RESERVE_CACHE_PATH, "utf8"));
    const fetchedAt = Date.parse(parsed?.fetchedAt);
    if (maxAgeMs != null && (!Number.isFinite(fetchedAt) || now - fetchedAt > maxAgeMs)) {
      return new Map();
    }
    const rows = Array.isArray(parsed?.accounts) ? parsed.accounts : [];
    return new Map(
      rows
        .filter((entry) => entry && typeof entry.id === "string")
        .map((entry) => [entry.id, entry]),
    );
  } catch {
    return new Map();
  }
}

export function persistReserveCache(snapshot) {
  writePrivateJson(
    CHATGPT_RESERVE_CACHE_PATH,
    {
      fetchedAt: snapshot?.fetchedAt || new Date().toISOString(),
      accounts: (snapshot?.accounts || []).map((entry) => ({
        id: entry.id,
        present: Boolean(entry.present),
        allowed: Boolean(entry.allowed),
        ...(Number.isFinite(entry.remainingPercent)
          ? { remainingPercent: entry.remainingPercent }
          : {}),
        ...(Number.isFinite(entry.resetAt) ? { resetAt: entry.resetAt } : {}),
      })),
    },
    { directoryMode: 0o700 },
  );
  return snapshot;
}
