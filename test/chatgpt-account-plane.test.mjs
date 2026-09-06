import assert from "node:assert/strict";
import test from "node:test";

import {
  inferPurpose,
  leftoverHealth,
  normalizeRules,
  orderChatGptAccountCandidates,
  pickChatGptAccount,
  reserveResumeDecisions,
  windowReset,
} from "../src/chatgpt-account-plane.mjs";

test("purpose inference maps labels without inventing fingerprints", () => {
  assert.equal(inferPurpose("Current Codex login", { id: "default" }), "personal");
  assert.equal(inferPurpose("rubina.bajwa@auraone.ai"), "auraone");
  assert.equal(inferPurpose("gc@veerone.com"), "veerone");
  assert.equal(inferPurpose("gchahal@chahalfoundation.org"), "foundation");
  assert.equal(inferPurpose("Backup Pro", { state: "paused" }), "reserve");
});

test("soft leftover demotes new chats but sticky stays first", () => {
  const leftoverById = new Map([
    ["default", { weekly: { remainingPercent: 12 } }],
    ["chatgpt_healthyaccount0001", { weekly: { remainingPercent: 40 }, fiveHour: { remainingPercent: 80 } }],
  ]);
  assert.equal(leftoverHealth(leftoverById.get("default")), "soft");
  assert.equal(leftoverHealth(leftoverById.get("chatgpt_healthyaccount0001")), "healthy");
  const next = orderChatGptAccountCandidates(
    [{ id: "default" }, { id: "chatgpt_healthyaccount0001" }],
    { preferred: "default", leftoverById, order: ["default", "chatgpt_healthyaccount0001"] },
  );
  assert.deepEqual(next.map((entry) => entry.id), ["chatgpt_healthyaccount0001", "default"]);
  const sticky = orderChatGptAccountCandidates(
    [{ id: "default" }, { id: "chatgpt_healthyaccount0001" }],
    { sticky: "default", preferred: "default", leftoverById, order: ["default", "chatgpt_healthyaccount0001"] },
  );
  assert.equal(sticky[0].id, "default");
});

test("purpose pins break leftover ties after preferred", () => {
  const leftoverById = {
    personal: { weekly: { remainingPercent: 40 } },
    auraone: { weekly: { remainingPercent: 40 } },
    veerone: { weekly: { remainingPercent: 40 } },
  };
  const ordered = orderChatGptAccountCandidates(
    [{ id: "veerone" }, { id: "auraone" }, { id: "personal" }],
    {
      leftoverById,
      purposeById: { personal: "personal", auraone: "auraone", veerone: "veerone" },
      pinOrder: ["personal", "auraone", "veerone", "foundation"],
      order: ["veerone", "auraone", "personal"],
    },
  );
  assert.deepEqual(ordered.map((entry) => entry.id), ["personal", "auraone", "veerone"]);
  assert.equal(
    pickChatGptAccount(["veerone", "auraone"], {
      leftoverById,
      purposeById: { auraone: "auraone", veerone: "veerone" },
    }),
    "auraone",
  );
});

test("reserves resume on leftover reset or when active weekly is thin", () => {
  const rules = normalizeRules({ reserveUntilPercent: 20, autoResumeOnReset: true });
  const reset = reserveResumeDecisions({
    previousById: new Map([["reserve", { weekly: { remainingPercent: 0 } }]]),
    accounts: [{ id: "reserve", state: "paused", weekly: { remainingPercent: 80 } }],
    purposeById: new Map([["reserve", "reserve"]]),
    rules,
  });
  assert.deepEqual(reset, [{ id: "reserve", reason: "reset" }]);
  assert.equal(windowReset(0, 80), true);
  const thin = reserveResumeDecisions({
    previousById: new Map([["reserve", { weekly: { remainingPercent: 40 } }]]),
    accounts: [
      { id: "active", state: "active", weekly: { remainingPercent: 8 } },
      { id: "reserve", state: "paused", weekly: { remainingPercent: 40 } },
    ],
    purposeById: new Map([["active", "personal"], ["reserve", "reserve"]]),
    rules,
  });
  assert.deepEqual(thin, [{ id: "reserve", reason: "reserve" }]);
});
