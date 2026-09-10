import { recentUsageEvents } from "./usage-events.mjs";

export const CHATGPT_ACCOUNT_PURPOSES = Object.freeze([
  "personal",
  "auraone",
  "veerone",
  "foundation",
  "reserve",
]);

export const DEFAULT_PIN_ORDER = Object.freeze(["personal", "auraone", "veerone", "foundation"]);
export const DRAINED_LEFTOVER_PERCENT = 0.5;
export const SOFT_DRAIN_PERCENT = 15;
export const RESERVE_UNTIL_PERCENT = 20;
export const RESET_JUMP_PERCENT = 25;
export const LEFTOVER_CACHE_MAX_AGE_MS = 20 * 60 * 1000;
export const LEFTOVER_PROBE_MS = 30_000;

export function normalizePurpose(value) {
  const purpose = String(value || "").trim().toLowerCase();
  return CHATGPT_ACCOUNT_PURPOSES.includes(purpose) ? purpose : undefined;
}

export function inferPurpose(label, { id, state } = {}) {
  const text = `${label || ""} ${id || ""}`.toLowerCase();
  if (text.includes("auraone")) return "auraone";
  if (text.includes("veerone")) return "veerone";
  if (text.includes("foundation")) return "foundation";
  if (state === "paused" || text.includes("backup") || text.includes("reserve")) return "reserve";
  if (id === "default") return "personal";
  return "personal";
}

export function normalizeRules(rules) {
  const pinOrder = Array.isArray(rules?.pinOrder)
    ? rules.pinOrder.map(normalizePurpose).filter(Boolean)
    : [];
  const seen = new Set();
  const pins = [...pinOrder, ...DEFAULT_PIN_ORDER].filter((purpose) => {
    if (seen.has(purpose) || purpose === "reserve") return false;
    seen.add(purpose);
    return true;
  });
  const softDrainPercent = Number(rules?.softDrainPercent);
  const reserveUntilPercent = Number(rules?.reserveUntilPercent);
  return {
    pinOrder: pins,
    softDrainPercent: Number.isFinite(softDrainPercent)
      ? Math.min(40, Math.max(1, softDrainPercent))
      : SOFT_DRAIN_PERCENT,
    reserveUntilPercent: Number.isFinite(reserveUntilPercent)
      ? Math.min(80, Math.max(1, reserveUntilPercent))
      : RESERVE_UNTIL_PERCENT,
    autoResumeOnReset: rules?.autoResumeOnReset !== false,
  };
}

export function leftoverWindows(row) {
  return [row?.fiveHour, row?.weekly].filter((window) => window && Number.isFinite(window.remainingPercent));
}

export function leftoverHealth(row, softDrainPercent = SOFT_DRAIN_PERCENT) {
  const windows = leftoverWindows(row);
  if (!windows.length) return "unknown";
  if (windows.some((window) => window.remainingPercent <= DRAINED_LEFTOVER_PERCENT)) return "drained";
  if (windows.some((window) => window.remainingPercent <= softDrainPercent)) return "soft";
  return "healthy";
}

export function chatGptAccountIsDrained(row) {
  return leftoverHealth(row) === "drained";
}

export function orderChatGptAccountCandidates(candidates, {
  sticky,
  preferred,
  leftoverById,
  order,
  purposeById,
  pinOrder = DEFAULT_PIN_ORDER,
  softDrainPercent = SOFT_DRAIN_PERCENT,
  reserveById,
} = {}) {
  const leftover = leftoverById instanceof Map ? leftoverById : new Map(Object.entries(leftoverById || {}));
  const purposes = purposeById instanceof Map ? purposeById : new Map(Object.entries(purposeById || {}));
  const reserve = reserveById instanceof Map ? reserveById : new Map(Object.entries(reserveById || {}));
  const orderIndex = new Map((order || []).map((id, index) => [id, index]));
  const pinIndex = new Map((pinOrder || DEFAULT_PIN_ORDER).map((purpose, index) => [purpose, index]));
  // A spent Codex quota is not the end of an account's usefulness when it also
  // carries the Luna reserve: that is a separate allowance on the same
  // subscription, so such an account outranks one that is drained outright.
  // It still sorts behind any account with ordinary quota left, because
  // spending the reserve is a fallback rather than a first choice.
  const hasReserve = (id) => {
    const row = reserve.get(id);
    return Boolean(row?.present && row?.allowed);
  };
  const leftoverRank = (id) => {
    const health = leftoverHealth(leftover.get(id), softDrainPercent);
    if (health === "drained") return hasReserve(id) ? 3 : 4;
    if (health === "soft") return 2;
    return 1;
  };
  const purposeRank = (id) => pinIndex.get(purposes.get(id)) ?? 50;
  return [...candidates].sort((left, right) => {
    const rank = (entry) => {
      if (entry.id === sticky) return 0;
      const quota = leftoverRank(entry.id);
      const home = entry.id === preferred;
      if (quota === 1 && home) return 1;
      if (quota === 1) return 2;
      if (quota === 2 && home) return 3;
      if (quota === 2) return 4;
      // Drained on Codex quota but holding a live Luna reserve. Ahead of a fully
      // drained account, behind everything that still has ordinary quota.
      if (quota === 3 && home) return 5;
      if (quota === 3) return 6;
      if (home) return 7;
      return 8;
    };
    const delta = rank(left) - rank(right);
    if (delta !== 0) return delta;
    const purposeDelta = purposeRank(left.id) - purposeRank(right.id);
    if (purposeDelta !== 0) return purposeDelta;
    return (orderIndex.get(left.id) ?? 999) - (orderIndex.get(right.id) ?? 999);
  });
}

export function pickChatGptAccount(candidateIds, options) {
  const ordered = orderChatGptAccountCandidates(
    (candidateIds || []).map((id) => ({ id })),
    options,
  );
  return ordered[0]?.id;
}

export function chatGptAccountSpendToday({ now = Date.now() } = {}) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const startMs = start.getTime();
  const spend = {};
  for (const event of recentUsageEvents({ sinceMs: now - startMs + 3_600_000, limit: 20_000 })) {
    if (event.provider !== "openai" || typeof event.accountId !== "string") continue;
    const at = Date.parse(event.at);
    if (!Number.isFinite(at) || at < startMs) continue;
    const tokens = Number(event.totalTokens);
    if (!Number.isFinite(tokens) || tokens <= 0) continue;
    spend[event.accountId] = (spend[event.accountId] || 0) + tokens;
  }
  return spend;
}

export function windowReset(previous, current) {
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return false;
  return current - previous >= RESET_JUMP_PERCENT;
}

export function reserveResumeDecisions({
  previousById,
  accounts,
  purposeById,
  rules,
}) {
  const resume = [];
  const activeWeekly = accounts
    .filter((entry) => entry.state === "active")
    .map((entry) => entry.weekly?.remainingPercent)
    .filter((value) => Number.isFinite(value));
  const bestActiveWeekly = activeWeekly.length ? Math.max(...activeWeekly) : 0;
  const needReserve = bestActiveWeekly < rules.reserveUntilPercent;
  for (const account of accounts) {
    const purpose = purposeById.get(account.id);
    if (purpose !== "reserve" || account.state !== "paused") continue;
    const health = leftoverHealth(account, rules.softDrainPercent);
    if (health === "drained") continue;
    const prior = previousById.get(account.id);
    const reset = windowReset(prior?.weekly?.remainingPercent, account.weekly?.remainingPercent)
      || windowReset(prior?.fiveHour?.remainingPercent, account.fiveHour?.remainingPercent);
    if ((rules.autoResumeOnReset && reset) || (needReserve && health === "healthy")) {
      resume.push({ id: account.id, reason: reset ? "reset" : "reserve" });
    }
  }
  return resume;
}
