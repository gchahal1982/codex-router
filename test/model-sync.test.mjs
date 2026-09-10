import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

function writeDesktopState(file, recent) {
  writeFileSync(file, JSON.stringify({
    "electron-persisted-atom-state": {
      "composer-recent-model-configurations-v1": recent,
    },
  }));
}

const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-model-sync-"));
const stateFile = path.join(root, "global.json");
const syncFile = path.join(root, "sync.json");
const databaseFile = path.join(root, "state.sqlite");
process.env.MODEL_ROUTER_STATE_DIR = root;
process.env.MODEL_ROUTER_CODEX_GLOBAL_STATE = stateFile;
process.env.MODEL_ROUTER_MODEL_SYNC_STATE = syncFile;
process.env.MODEL_ROUTER_CODEX_STATE_DATABASE = databaseFile;
const module = await import(`${pathToFileURL(path.resolve("src/model-sync.mjs"))}?fixture=${Date.now()}`);

function resetFixture() {
  for (const file of [stateFile, syncFile, databaseFile]) {
    if (existsSync(file)) unlinkSync(file);
  }
  const database = new DatabaseSync(databaseFile);
  database.exec("create table threads (id text primary key, model text, thread_source text, source text, updated_at_ms integer)");
  database.close();
}

function setThreadModel(id, model, source = "user") {
  const database = new DatabaseSync(databaseFile);
  database.prepare(
    "insert into threads (id, model, thread_source, source, updated_at_ms) values (?, ?, ?, 'vscode', ?) " +
    "on conflict(id) do update set model=excluded.model, updated_at_ms=excluded.updated_at_ms",
  ).run(id, model, source, Date.now());
  database.close();
}

test("model sync is opt-in and follows the newest desktop picker selection", async () => {
  resetFixture();
  writeDesktopState(stateFile, [{ model: "gpt-5.6-sol", reasoningEffort: "high" }]);
  setThreadModel("one", "gpt-5.6-sol");
  setThreadModel("two", "gpt-5-codex");

  const original = { model: "gpt-5-codex", reasoning: { effort: "low" }, input: "hello" };
  assert.equal(module.synchronizedPayload(original), original);

  const enabled = module.setModelSyncEnabled(true);
  assert.equal(enabled.selectedModel, "gpt-5.6-sol");
  assert.equal(JSON.parse(readFileSync(syncFile, "utf8")).enabled, true);

  const first = module.synchronizedPayload(original, { threadId: "two" });
  assert.deepEqual(first, { ...original, model: "gpt-5.6-sol" });
  assert.deepEqual(first.reasoning, { effort: "low" }, "per-task reasoning is preserved");
  assert.equal(original.model, "gpt-5-codex", "the caller payload is not mutated");

  // Moving one thread's picker is a statement about that thread. It keeps its
  // own model, and every other window stays on the global default.
  setThreadModel("one", "deepseek/deepseek-v4-flash");
  const refreshed = module.refreshModelSyncFromCodex();
  assert.equal(refreshed.selectedModel, "gpt-5.6-sol", "the global default is untouched");
  assert.equal(refreshed.pinnedThreadCount, 1);
  const selected = module.synchronizedPayload(
    { ...original, model: "deepseek/deepseek-v4-flash" },
    { threadId: "one" },
  );
  assert.equal(selected.model, "deepseek/deepseek-v4-flash", "the pinned thread keeps its choice");
  assert.equal(
    module.synchronizedPayload(original, { threadId: "two" }).model,
    "gpt-5.6-sol",
    "an unpinned thread still follows the default",
  );

  // Returning the thread to the default releases the pin; no unpin step needed.
  setThreadModel("one", "gpt-5.6-sol");
  assert.equal(module.refreshModelSyncFromCodex().pinnedThreadCount, undefined);
});

test("exact-route probes bypass sync and damaged state fails closed", async () => {
  resetFixture();
  writeDesktopState(stateFile, [{ model: "gpt-5.6-sol" }]);
  module.setModelSyncEnabled(true);
  const original = { model: "provider/probe" };
  assert.equal(module.synchronizedPayload(original, { bypass: true }), original);

  writeFileSync(syncFile, "not json");
  assert.equal(module.modelSyncSnapshot().invalid, true);
  assert.equal(module.synchronizedPayload(original), original);
});

test("independent chat and automation defaults apply model and nested effort", async () => {
  resetFixture();
  writeDesktopState(stateFile, [{ model: "gpt-5.6-sol" }]);
  setThreadModel("chat", "gpt-5.6-sol");
  setThreadModel("cron", "gpt-5.6-sol", "automation");
  module.setModelSyncEnabled(true);
  module.setModelSyncDefaults({
    chatModel: "deepseek/deepseek-v4-flash",
    cronModel: "kiro-prism/gpt-5.6-sol",
  });
  module.setModelSyncEfforts({ chatEffort: "high", cronEffort: "medium" });

  assert.deepEqual(
    module.synchronizedPayload(
      { model: "gpt-5.6-sol", reasoning: { summary: "auto" } },
      { threadId: "chat" },
    ),
    {
      model: "deepseek/deepseek-v4-flash",
      reasoning: { summary: "auto", effort: "high" },
      reasoning_effort: "high",
    },
  );
  assert.deepEqual(
    module.synchronizedPayload({ model: "gpt-5.6-sol" }, { threadId: "cron" }),
    { model: "kiro-prism/gpt-5.6-sol", reasoning: { effort: "medium" }, reasoning_effort: "medium" },
  );
});

test("enabling sync requires a recorded desktop model", async () => {
  resetFixture();
  assert.throws(
    () => module.setModelSyncEnabled(true),
    /Choose a model in Codex first/,
  );
});

test("an automation effort override applies without a cron model override", async () => {
  resetFixture();
  writeDesktopState(stateFile, [{ model: "gpt-5.6-sol" }]);
  setThreadModel("chat", "gpt-5.6-sol");
  setThreadModel("cron", "gpt-5.6-sol", "automation");
  module.setModelSyncEnabled(true);
  module.setModelSyncDefaults({ chatModel: "kiro-prism/gpt-5.6-sol", cronModel: "" });
  module.setModelSyncEfforts({ cronEffort: "xhigh" });

  assert.deepEqual(
    module.synchronizedPayload({ model: "gpt-5.6-sol" }, { threadId: "chat" }),
    { model: "kiro-prism/gpt-5.6-sol" },
    "a chat turn keeps its own effort when only the automation level is set",
  );
  assert.deepEqual(
    module.synchronizedPayload({ model: "gpt-5.6-sol" }, { threadId: "cron" }),
    { model: "kiro-prism/gpt-5.6-sol", reasoning: { effort: "xhigh" }, reasoning_effort: "xhigh" },
  );
});

test("default clears an effort override and off-ladder levels are refused", async () => {
  resetFixture();
  writeDesktopState(stateFile, [{ model: "gpt-5.6-sol" }]);
  setThreadModel("chat", "gpt-5.6-sol");
  module.setModelSyncEnabled(true);
  module.setModelSyncEfforts({ chatEffort: "high" });
  assert.equal(module.modelSyncSnapshot().chatEffort, "high");

  assert.equal(module.setModelSyncEfforts({ chatEffort: "default" }).chatEffort, undefined);
  assert.deepEqual(
    module.synchronizedPayload({ model: "gpt-5.6-sol", reasoning: { effort: "low" } }, { threadId: "chat" }),
    { model: "gpt-5.6-sol", reasoning: { effort: "low" } },
    "clearing the override leaves the task's own effort untouched",
  );

  assert.throws(() => module.setModelSyncEfforts({ chatEffort: "turbo" }), /must be one of/);
  // A hand-edited level never reaches a provider request.
  const stored = JSON.parse(readFileSync(syncFile, "utf8"));
  writeFileSync(syncFile, JSON.stringify({ ...stored, chatEffort: "turbo" }));
  assert.equal(module.modelSyncSnapshot().chatEffort, undefined);
  assert.deepEqual(
    module.synchronizedPayload({ model: "gpt-5.6-sol" }, { threadId: "chat" }),
    { model: "gpt-5.6-sol" },
  );
});

test("a thread's own picker choice supersedes the global default", async () => {
  resetFixture();
  writeDesktopState(stateFile, [{ model: "gpt-5.6-sol" }]);
  setThreadModel("mine", "gpt-5.6-sol");
  setThreadModel("other", "gpt-5.6-sol");
  module.setModelSyncEnabled(true);
  module.setModelSyncDefaults({ chatModel: "kiro-prism/gpt-5.6-sol" });
  module.setModelSyncEfforts({ chatEffort: "high" });

  // Both threads start on the global default, effort included.
  assert.deepEqual(
    module.synchronizedPayload({ model: "gpt-5.6-sol" }, { threadId: "mine" }),
    { model: "kiro-prism/gpt-5.6-sol", reasoning: { effort: "high" }, reasoning_effort: "high" },
  );

  // The operator moves this one thread's dropdown. The router records the pin
  // and stops overriding the thread, model and effort alike.
  const pinned = module.synchronizedPayload(
    { model: "deepseek/deepseek-v4-flash" },
    { threadId: "mine" },
  );
  assert.deepEqual(pinned, { model: "deepseek/deepseek-v4-flash" });
  assert.equal(module.modelSyncSnapshot().pinnedThreadCount, 1);

  // Later turns in that thread keep its model and are never given the default
  // effort back.
  assert.deepEqual(
    module.synchronizedPayload({ model: "deepseek/deepseek-v4-flash" }, { threadId: "mine" }),
    { model: "deepseek/deepseek-v4-flash" },
  );

  // The global default still governs every other window and the snapshot.
  const snapshot = module.modelSyncSnapshot();
  assert.equal(snapshot.chatModel, "kiro-prism/gpt-5.6-sol");
  assert.deepEqual(
    module.synchronizedPayload({ model: "gpt-5.6-sol" }, { threadId: "other" }),
    { model: "kiro-prism/gpt-5.6-sol", reasoning: { effort: "high" }, reasoning_effort: "high" },
  );

  // Choosing the default again in that thread hands it back to the router.
  assert.deepEqual(
    module.synchronizedPayload({ model: "kiro-prism/gpt-5.6-sol" }, { threadId: "mine" }),
    { model: "kiro-prism/gpt-5.6-sol", reasoning: { effort: "high" }, reasoning_effort: "high" },
  );
  assert.equal(module.modelSyncSnapshot().pinnedThreadCount, undefined);
});

test("a new thread is adopted by the default rather than pinned", async () => {
  resetFixture();
  writeDesktopState(stateFile, [{ model: "gpt-5.6-sol" }]);
  setThreadModel("existing", "gpt-5.6-sol");
  module.setModelSyncEnabled(true);
  module.setModelSyncDefaults({ chatModel: "kiro-prism/gpt-5.6-sol" });

  // A window Codex opened after sync was enabled has no observed history. It
  // arrives on whatever Codex hardwired, which is not a picker decision, so the
  // default applies and no pin is recorded.
  assert.deepEqual(
    module.synchronizedPayload({ model: "gpt-5-codex" }, { threadId: "fresh" }),
    { model: "kiro-prism/gpt-5.6-sol" },
  );
  assert.equal(module.modelSyncSnapshot().pinnedThreadCount, undefined);
});

test("the ChatGPT reserve allowance passes through and never pins a thread", async () => {
  resetFixture();
  writeDesktopState(stateFile, [{ model: "gpt-5.6-sol" }]);
  setThreadModel("chat", "gpt-5.6-sol");
  module.setModelSyncEnabled(true);
  module.setModelSyncDefaults({ chatModel: "kiro-prism/claude-opus-5" });
  module.setModelSyncEfforts({ chatEffort: "high" });

  // Codex swaps to the reserve allowance on its own once the primary ChatGPT
  // limit is spent. Rewriting that to the routed default would skip a budget the
  // operator already pays for, so the turn is relayed exactly as it arrived --
  // including no effort override, which belongs to the routed default.
  const reserve = module.synchronizedPayload({ model: "gpt-reserve" }, { threadId: "chat" });
  assert.deepEqual(reserve, { model: "gpt-reserve" });
  assert.equal(
    module.modelSyncSnapshot().pinnedThreadCount,
    undefined,
    "an automatic escalation is not a picker choice",
  );

  // Once the reserve window resets, the thread is governed by the default again
  // rather than being stranded on whatever the app last sent.
  assert.deepEqual(
    module.synchronizedPayload({ model: "gpt-5.6-sol" }, { threadId: "chat" }),
    {
      model: "kiro-prism/claude-opus-5",
      reasoning: { effort: "high" },
      reasoning_effort: "high",
    },
  );

  // The background watcher applies the same rule.
  setThreadModel("chat", "gpt-reserve");
  assert.equal(module.refreshModelSyncFromCodex().pinnedThreadCount, undefined);
});
