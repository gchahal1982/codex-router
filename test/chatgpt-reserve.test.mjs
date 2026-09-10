import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(path.join(os.tmpdir(), "chatgpt-reserve-"));
const accountsDir = path.join(root, "accounts");
process.env.MODEL_ROUTER_STATE_DIR = root;
process.env.MODEL_ROUTER_CHATGPT_ACCOUNTS_DIR = accountsDir;
process.env.MODEL_ROUTER_CHATGPT_RESERVE_STATE = path.join(root, "reserve.json");
process.env.MODEL_ROUTER_CHATGPT_RESERVE_CACHE = path.join(root, "reserve-cache.json");

const reserve = await import(
  `${pathToFileURL(path.resolve("src/chatgpt-reserve.mjs"))}?fixture=${Date.now()}`
);
const plane = await import("../src/chatgpt-account-plane.mjs");

function writeAccount(id, token = "header.payload.signature") {
  const home = path.join(accountsDir, id);
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(home, "auth.json"),
    JSON.stringify({ tokens: { access_token: token, account_id: `acct-${id}` } }),
  );
}

// The exact shape the live endpoint returns for an account that carries the
// allowance, captured from a real probe.
function reservePayload({ allowed = true, usedPercent = 53 } = {}) {
  return {
    plan_type: "plus",
    additional_rate_limits: [
      {
        limit_name: "gpt-reserve",
        metered_feature: "base_model_inference",
        normal_model_slug: "gpt-5.6-luna",
        rate_limit: {
          allowed,
          limit_reached: !allowed,
          primary_window: { used_percent: usedPercent, reset_at: 1789319275 },
        },
      },
    ],
  };
}

test("reserve is read from additional_rate_limits, not the plan type", () => {
  const withReserve = reserve.normalizeReserve(reservePayload());
  assert.equal(withReserve.present, true);
  assert.equal(withReserve.allowed, true);
  assert.equal(withReserve.remainingPercent, 47);
  assert.equal(withReserve.modelSlug, "gpt-5.6-luna");
  assert.equal(withReserve.meteredFeature, "base_model_inference");

  // A Codex-only account reports null here, which is the observed difference
  // between two accounts on the same Plus plan.
  assert.deepEqual(
    reserve.normalizeReserve({ plan_type: "plus", additional_rate_limits: null }),
    { present: false, allowed: false },
  );
  // Present but spent is not usable; the client tests `allowed` and so does this.
  assert.equal(reserve.normalizeReserve(reservePayload({ allowed: false })).allowed, false);
});

test("the probe reports availability per account and fails closed", async () => {
  writeAccount("chatgpt_haseslug");
  writeAccount("chatgpt_noreserve");

  const fetchImpl = async (url, options) => {
    assert.match(String(url), /\/wham\/usage$/);
    assert.match(options.headers.authorization, /^Bearer /);
    const account = options.headers["ChatGPT-Account-Id"];
    if (account === "acct-chatgpt_haseslug") {
      return { ok: true, json: async () => reservePayload() };
    }
    return { ok: true, json: async () => ({ additional_rate_limits: null }) };
  };

  assert.equal((await reserve.probeAccountReserve("chatgpt_haseslug", { fetchImpl })).allowed, true);
  assert.equal((await reserve.probeAccountReserve("chatgpt_noreserve", { fetchImpl })).allowed, false);

  // An unreachable endpoint reports absent rather than guessing available:
  // rotating into an account on an unverified guess spends the wrong plan.
  const failing = await reserve.probeAccountReserve("chatgpt_haseslug", {
    fetchImpl: async () => { throw new Error("network down"); },
  });
  assert.deepEqual(failing, { present: false, allowed: false, error: "Reserve probe failed." });

  // A missing session is not an error state either.
  assert.equal((await reserve.probeAccountReserve("chatgpt_absent", { fetchImpl })).allowed, false);
});

test("discovery names the eligible accounts and caches them", async () => {
  writeAccount("chatgpt_one");
  writeAccount("chatgpt_two");
  const fetchImpl = async (url, options) =>
    options.headers["ChatGPT-Account-Id"] === "acct-chatgpt_one"
      ? { ok: true, json: async () => reservePayload() }
      : { ok: true, json: async () => ({ additional_rate_limits: null }) };

  const found = await reserve.discoverReserveAccounts({
    accountIds: ["chatgpt_one", "chatgpt_two"],
    fetchImpl,
    labelById: new Map([["chatgpt_one", "gc@veerone.com"]]),
  });
  assert.deepEqual(found.eligible, ["chatgpt_one"]);
  assert.equal(found.accounts[0].label, "gc@veerone.com");

  reserve.persistReserveCache(found);
  const cached = reserve.reserveByIdFromCache();
  assert.equal(cached.get("chatgpt_one").allowed, true);
  assert.equal(cached.get("chatgpt_two").allowed, false);

  // A stale cache stops influencing routing rather than steering it on old data.
  assert.equal(reserve.reserveByIdFromCache(Date.now() + 60 * 60 * 1000).size, 0);
});

test("settings default to medium and refuse to enable with no accounts", () => {
  const initial = reserve.readReserveSettings();
  assert.equal(initial.enabled, false);
  assert.equal(initial.effort, "medium");

  assert.throws(() => reserve.setReserveSettings({ enabled: true }), /at least one reserve account/);

  const configured = reserve.setReserveSettings({
    accounts: ["chatgpt_one", "chatgpt_two"],
    enabled: true,
  });
  assert.equal(configured.enabled, true);
  assert.deepEqual(configured.accounts, ["chatgpt_one", "chatgpt_two"]);
  assert.equal(configured.effort, "medium", "medium unless the operator says otherwise");

  assert.equal(reserve.setReserveSettings({ effort: "high" }).effort, "high");
  assert.equal(reserve.setReserveSettings({ cronEffort: "low" }).cronEffort, "low");
  assert.throws(() => reserve.setReserveSettings({ effort: "turbo" }), /must be one of/);
  assert.throws(() => reserve.setReserveSettings({ accounts: ["../etc"] }), /Invalid ChatGPT account id/);
});

test("a drained account holding reserve outranks one that is drained outright", () => {
  const drained = { fiveHour: { remainingPercent: 0 }, weekly: { remainingPercent: 0 } };
  const healthy = { fiveHour: { remainingPercent: 80 }, weekly: { remainingPercent: 70 } };
  const candidates = [{ id: "pro_home" }, { id: "pro_other" }, { id: "plus_reserve" }];
  const reserveById = new Map([["plus_reserve", { present: true, allowed: true }]]);

  // Everything spent: the reserve account leads, even over the preferred home.
  assert.deepEqual(
    plane.orderChatGptAccountCandidates(candidates, {
      preferred: "pro_home",
      leftoverById: new Map([
        ["pro_home", drained],
        ["pro_other", drained],
        ["plus_reserve", drained],
      ]),
      reserveById,
    }).map((entry) => entry.id),
    ["plus_reserve", "pro_home", "pro_other"],
  );

  // Ordinary quota still wins: spending the reserve is a fallback, not a
  // preference, so an account with real quota left goes first.
  assert.equal(
    plane.orderChatGptAccountCandidates(candidates, {
      preferred: "pro_home",
      leftoverById: new Map([
        ["pro_home", drained],
        ["pro_other", healthy],
        ["plus_reserve", drained],
      ]),
      reserveById,
    })[0].id,
    "pro_other",
  );

  // With no reserve information the order is exactly what it always was.
  assert.deepEqual(
    plane.orderChatGptAccountCandidates(candidates, {
      preferred: "pro_home",
      leftoverById: new Map([
        ["pro_home", drained],
        ["pro_other", drained],
        ["plus_reserve", drained],
      ]),
    }).map((entry) => entry.id),
    ["pro_home", "pro_other", "plus_reserve"],
  );
});
