import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { protectPrivateFile } from "./file-security.mjs";
import {
  CODEX_GLOBAL_STATE_PATH,
  CODEX_STATE_DATABASE_PATH,
  MODEL_SYNC_PATH,
} from "./paths.mjs";

const RECENT_MODELS_KEY = "composer-recent-model-configurations-v1";

// Codex escalates to the ChatGPT reserve budget by itself once the primary
// limit is spent: the app swaps the request model to this slug, which is a
// second allowance on the same subscription rather than a model anybody picked.
// It must pass through untouched -- rewriting it to a routed default would skip
// the reserve the operator already pays for -- and it is never a picker event,
// so it must not pin the thread either.
export const CHATGPT_RESERVE_SLUG = "gpt-reserve";

// A provider-qualified slug ("kiro-prism/claude-opus-5") is a routed model the
// operator selected. A bare slug ("gpt-5.6-sol", "gpt-6-astra") is native
// ChatGPT traffic that Codex hardwired. Same rule as `isNativeOpenAIRoute`.
function isRoutedSlug(slug) {
  return typeof slug === "string" && slug.includes("/");
}
// The published effort ladder, plus the sentinel that clears the override so
// each task keeps whatever effort it was created with.
export const EFFORT_LEVELS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const CLEAR_EFFORT = "default";

function normalizedEffort(value, label) {
  if (value === undefined) return undefined;
  const effort = String(value).trim();
  if (!effort || effort === CLEAR_EFFORT) return "";
  if (!EFFORT_LEVELS.includes(effort)) {
    throw new Error(`${label} must be one of: ${[CLEAR_EFFORT, ...EFFORT_LEVELS].join(", ")}.`);
  }
  return effort;
}

function readSettings() {
  if (!existsSync(MODEL_SYNC_PATH)) return { enabled: false };
  try {
    const parsed = JSON.parse(readFileSync(MODEL_SYNC_PATH, "utf8"));
    if (![1, 2].includes(parsed?.version) || typeof parsed.enabled !== "boolean") {
      throw new Error("invalid state");
    }
    return {
      enabled: parsed.enabled,
      selectedModel: typeof parsed.selectedModel === "string" ? parsed.selectedModel : undefined,
      chatModel: typeof parsed.chatModel === "string" ? parsed.chatModel : undefined,
      cronModel: typeof parsed.cronModel === "string" ? parsed.cronModel : undefined,
      // A model slug is only meaningful to the router, which already reports an
      // unknown one. An effort travels into a provider request, so an
      // off-ladder value edited in by hand is dropped rather than forwarded.
      chatEffort: EFFORT_LEVELS.includes(parsed.chatEffort) ? parsed.chatEffort : undefined,
      cronEffort: EFFORT_LEVELS.includes(parsed.cronEffort) ? parsed.cronEffort : undefined,
      // Threads whose own picker the operator moved after synchronization was
      // enabled. Those threads keep what they were pointed at, and the global
      // defaults stop applying to them.
      pinnedThreads: parsed.pinnedThreads && typeof parsed.pinnedThreads === "object"
        && !Array.isArray(parsed.pinnedThreads)
        ? parsed.pinnedThreads
        : {},
      observedModels: parsed.observedModels && typeof parsed.observedModels === "object"
        ? parsed.observedModels
        : {},
    };
  } catch {
    // A damaged consent file must never silently start overriding models.
    return { enabled: false, invalid: true };
  }
}

function readObservedThreadRows() {
  if (!existsSync(CODEX_STATE_DATABASE_PATH)) return [];
  let database;
  try {
    database = new DatabaseSync(CODEX_STATE_DATABASE_PATH, { readOnly: true });
    return database.prepare(
      "select id, model, updated_at_ms from threads " +
      "where thread_source = 'user' and source = 'vscode' and model is not null",
    ).all().map((row) => ({
      id: String(row.id),
      model: String(row.model),
      updatedAt: Number(row.updated_at_ms) || 0,
    }));
  } catch {
    return [];
  } finally {
    database?.close();
  }
}

function readObservedThreadModels() {
  return Object.fromEntries(readObservedThreadRows().map((row) => [row.id, row.model]));
}

// Every mutation routes through here, and a thread the operator pinned has to
// survive all of them: changing an effort default or absorbing a picker refresh
// has no business discarding per-thread choices. A caller that means to reset
// the pins passes its own `pinnedThreads`.
function writeSettings(settings) {
  const directory = path.dirname(MODEL_SYNC_PATH);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = `${MODEL_SYNC_PATH}.tmp.${process.pid}`;
  const pinnedThreads = settings.pinnedThreads ?? readSettings().pinnedThreads;
  const document = {
    version: 2,
    ...settings,
    ...(pinnedThreads && Object.keys(pinnedThreads).length ? { pinnedThreads } : {}),
  };
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, MODEL_SYNC_PATH);
    protectPrivateFile(MODEL_SYNC_PATH);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export function readCodexDesktopModelSelection() {
  try {
    const state = JSON.parse(readFileSync(CODEX_GLOBAL_STATE_PATH, "utf8"));
    const recent = state?.["electron-persisted-atom-state"]?.[RECENT_MODELS_KEY];
    const selected = Array.isArray(recent) ? recent[0] : undefined;
    const model = typeof selected?.model === "string" ? selected.model.trim() : "";
    if (!model) return undefined;
    return {
      model,
      ...(typeof selected.reasoningEffort === "string" && selected.reasoningEffort.trim()
        ? { reasoningEffort: selected.reasoningEffort.trim() }
        : {}),
    };
  } catch {
    return undefined;
  }
}

export function modelSyncSnapshot() {
  const settings = readSettings();
  const selection = readCodexDesktopModelSelection();
  return {
    enabled: settings.enabled,
    available: Boolean(selection),
    ...(settings.invalid ? { invalid: true } : {}),
    ...(settings.selectedModel || selection?.model
      ? { selectedModel: settings.selectedModel || selection.model }
      : {}),
    ...(settings.chatModel ? { chatModel: settings.chatModel } : {}),
    ...(settings.cronModel ? { cronModel: settings.cronModel } : {}),
    ...(settings.chatEffort ? { chatEffort: settings.chatEffort } : {}),
    ...(settings.cronEffort ? { cronEffort: settings.cronEffort } : {}),
    ...(selection?.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    // A count, not the map: the operator wants to know that some windows are
    // running their own model, and the thread ids themselves are not useful in
    // a status line.
    ...(Object.keys(settings.pinnedThreads || {}).length
      ? { pinnedThreadCount: Object.keys(settings.pinnedThreads).length }
      : {}),
    path: MODEL_SYNC_PATH,
  };
}

export function setModelSyncEnabled(enabled) {
  if (typeof enabled !== "boolean") throw new TypeError("enabled must be boolean.");
  if (enabled && !readCodexDesktopModelSelection()) {
    throw new Error("Codex has not recorded a model selection yet. Choose a model in Codex first.");
  }
  const selection = readCodexDesktopModelSelection();
  writeSettings({
    enabled,
    ...(enabled ? {
      selectedModel: selection.model,
      chatModel: selection.model,
      cronModel: selection.model,
      observedModels: readObservedThreadModels(),
    } : {}),
  });
  return modelSyncSnapshot();
}

export function setModelSyncDefaults({ chatModel, cronModel } = {}) {
  const settings = readSettings();
  if (!settings.enabled) throw new Error("Enable global model defaults first.");
  const next = { enabled: true, selectedModel: settings.selectedModel, observedModels: settings.observedModels };
  for (const key of ["chatEffort", "cronEffort"]) if (settings[key]) next[key] = settings[key];
  if (chatModel !== undefined) next.chatModel = chatModel || undefined;
  else if (settings.chatModel) next.chatModel = settings.chatModel;
  if (cronModel !== undefined) next.cronModel = cronModel || undefined;
  else if (settings.cronModel) next.cronModel = settings.cronModel;
  writeSettings(next);
  return modelSyncSnapshot();
}

export function setModelSyncEfforts({ chatEffort, cronEffort } = {}) {
  const settings = readSettings();
  if (!settings.enabled) throw new Error("Enable global model defaults first.");
  // Validate before the write so a rejected level cannot half-apply, and so the
  // CLI and the Control Center report the same accepted set.
  const chat = normalizedEffort(chatEffort, "Chat reasoning effort");
  const cron = normalizedEffort(cronEffort, "Scheduled-task reasoning effort");
  const next = { enabled: true, selectedModel: settings.selectedModel, observedModels: settings.observedModels };
  for (const key of ["chatModel", "cronModel", "chatEffort", "cronEffort"]) if (settings[key]) next[key] = settings[key];
  if (chat !== undefined) next.chatEffort = chat || undefined;
  if (cron !== undefined) next.cronEffort = cron || undefined;
  writeSettings(next);
  return modelSyncSnapshot();
}

export function refreshModelSyncFromCodex() {
  const settings = readSettings();
  if (!settings.enabled) return modelSyncSnapshot();
  const rows = readObservedThreadRows();
  const observedModels = Object.fromEntries(rows.map((row) => [row.id, row.model]));
  const changed = rows
    .filter((row) => settings.observedModels[row.id] && settings.observedModels[row.id] !== row.model);
  const inventoryChanged = Object.keys(observedModels).length !== Object.keys(settings.observedModels).length;
  if (!changed.length && !inventoryChanged) return modelSyncSnapshot();
  // A thread whose picker moved is pinned to its own choice rather than
  // redefining the global default. The operator sets the defaults in one place
  // -- the Control Center -- so a single window changing its model must not
  // quietly repoint every other window and scheduled task.
  const pinnedThreads = { ...settings.pinnedThreads };
  // Every thread on a routed model is recorded, not only the ones seen changing.
  // A window that has been on `kiro-prism/...` since before these defaults
  // existed never appeared in `changed`, so it never got recorded and the
  // snapshot under-reported how many windows run their own model.
  for (const row of rows) {
    if (isRoutedSlug(row.model)) pinnedThreads[row.id] = row.model;
  }
  for (const row of changed) {
    // An automatic escalation to the reserve allowance is not a picker choice,
    // so it neither creates a pin nor clears one the operator made.
    if (row.model === CHATGPT_RESERVE_SLUG) continue;
    // A routed model is handled above and is never released by a default.
    if (isRoutedSlug(row.model)) continue;
    const globalModel = settings.chatModel || settings.selectedModel;
    if (row.model === globalModel) delete pinnedThreads[row.id];
    else pinnedThreads[row.id] = row.model;
  }
  writeSettings({
    enabled: true,
    selectedModel: settings.selectedModel,
    ...(settings.chatModel ? { chatModel: settings.chatModel } : {}),
    ...(settings.cronModel ? { cronModel: settings.cronModel } : {}),
    ...(settings.chatEffort ? { chatEffort: settings.chatEffort } : {}),
    ...(settings.cronEffort ? { cronEffort: settings.cronEffort } : {}),
    pinnedThreads,
    observedModels,
  });
  return modelSyncSnapshot();
}

export function startModelSyncWatcher({ intervalMs = 500 } = {}) {
  const timer = setInterval(() => {
    try {
      refreshModelSyncFromCodex();
    } catch {
      // Synchronization is optional and must never take down the request path.
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// Whether a thread is a cron/automation run rather than an interactive window.
// Both the global defaults and the native-takeover effort split need this, and
// an unreadable database means "not an automation": treating an ordinary chat as
// a scheduled task would apply the wrong depth to the visible one.
export function isAutomationThread(threadId) {
  const id = typeof threadId === "string" ? threadId.trim() : "";
  if (!id) return false;
  let database;
  try {
    database = new DatabaseSync(CODEX_STATE_DATABASE_PATH, { readOnly: true });
    const row = database.prepare("select thread_source from threads where id = ? limit 1").get(id);
    return row?.thread_source === "automation";
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

// The router is the one common execution point for every Codex window and for
// cron automations. Replacing only the model field here makes the latest desktop
// picker choice authoritative on the next turn without rewriting prompts,
// schedules, notification policies, project bindings, or per-task reasoning.
export function synchronizedPayload(payload, { bypass = false, threadId } = {}) {
  if (bypass || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const settings = readSettings();
  if (!settings.enabled) return payload;
  const incomingModel = typeof payload.model === "string" ? payload.model.trim() : "";
  const id = typeof threadId === "string" ? threadId.trim() : "";
  let selectedModel = settings.chatModel || settings.selectedModel || readCodexDesktopModelSelection()?.model;
  let selectedEffort = settings.chatEffort;
  // An operator can override the automation effort without overriding its model,
  // so the thread-source lookup has to run for either override on its own.
  if (id && (settings.cronModel || settings.cronEffort) && isAutomationThread(id)) {
    if (settings.cronModel) selectedModel = settings.cronModel;
    selectedEffort = settings.cronEffort || selectedEffort;
  }
  if (!selectedModel || !incomingModel) return payload;
  // The app reached for the reserve allowance on its own. Leave the turn exactly
  // as it arrived and record nothing: this thread has not changed what it wants,
  // it is spending the second half of the same subscription.
  if (incomingModel === CHATGPT_RESERVE_SLUG) return payload;

  // A turn that already names a routed model keeps it, always.
  //
  // This is the invariant these defaults exist inside, not a special case: a
  // thread on `kiro-prism/claude-opus-5` chose a non-native provider, and a
  // global default must never quietly move it back onto ChatGPT. The pin
  // bookkeeping below only ever noticed a *change* of model, so a thread that
  // had been sitting on a routed model since before these defaults existed was
  // never pinned -- and got rewritten to the native default on every turn.
  //
  // Guarding on the slug rather than on recorded history makes that impossible
  // regardless of what the state file remembers.
  //
  // It holds for routed-to-routed too. A thread on `kiro-prism/claude-opus-5`
  // named that provider and that model; silently serving it
  // `kiro-prism/gpt-5.6-sol` because that is the global default is the same
  // override in a smaller disguise. These defaults exist to place turns that
  // never made a choice -- native slugs Codex hardwired -- not to overrule one
  // the operator already made.
  if (isRoutedSlug(incomingModel)) {
    // Recorded so the watcher and the snapshot agree that this thread runs on
    // its own model, without the write being what protects it.
    if (id && settings.pinnedThreads[id] !== incomingModel) {
      writeSettings({
        enabled: true,
        selectedModel: settings.selectedModel,
        ...(settings.chatModel ? { chatModel: settings.chatModel } : {}),
        ...(settings.cronModel ? { cronModel: settings.cronModel } : {}),
        ...(settings.chatEffort ? { chatEffort: settings.chatEffort } : {}),
        ...(settings.cronEffort ? { cronEffort: settings.cronEffort } : {}),
        pinnedThreads: { ...settings.pinnedThreads, [id]: incomingModel },
        observedModels: { ...settings.observedModels, [id]: incomingModel },
      });
    }
    return payload;
  }

  const observedModel = id ? settings.observedModels[id] : undefined;
  const wasPinned = Boolean(id && settings.pinnedThreads[id]);
  // A thread that names a model other than the global default is running on its
  // own choice. That is true whether the operator just moved the dropdown or
  // moved it several turns ago, so one rule covers both: the thread is pinned
  // while it disagrees with the default, and released the moment it agrees
  // again. Nothing here rewrites the defaults -- those are set in one place.
  const pinnedNow = Boolean(id) && incomingModel !== selectedModel &&
    (wasPinned || Boolean(observedModel && observedModel !== incomingModel));
  const pinnedThreads = { ...settings.pinnedThreads };
  if (pinnedNow) pinnedThreads[id] = incomingModel;
  else if (id) delete pinnedThreads[id];
  const pinChanged = pinnedNow !== wasPinned ||
    (pinnedNow && settings.pinnedThreads[id] !== incomingModel);
  if (id && (pinChanged || !observedModel || observedModel !== incomingModel)) {
    writeSettings({
      enabled: true,
      selectedModel: settings.selectedModel,
      ...(settings.chatModel ? { chatModel: settings.chatModel } : {}),
      ...(settings.cronModel ? { cronModel: settings.cronModel } : {}),
      ...(settings.chatEffort ? { chatEffort: settings.chatEffort } : {}),
      ...(settings.cronEffort ? { cronEffort: settings.cronEffort } : {}),
      pinnedThreads,
      observedModels: { ...settings.observedModels, [id]: incomingModel },
    });
  }
  // Its own model means its own effort: forcing the default level onto a thread
  // the operator deliberately moved would be the same override they just
  // rejected, wearing a different field name.
  if (pinnedNow) return payload;
  const nextPayload = incomingModel === selectedModel ? payload : { ...payload, model: selectedModel };
  // Same contract as the subagent-effort override in the router: the Responses
  // API carries the level inside `reasoning`, and LiteLLM re-derives its own
  // flat value from that object whenever the client sent one -- which Codex
  // always does. Setting only the flat field would be discarded; setting only
  // the nested one leaves a bare chat-completions gateway with nothing to read.
  return selectedEffort && typeof nextPayload === "object"
    ? {
      ...nextPayload,
      reasoning: { ...(nextPayload.reasoning || {}), effort: selectedEffort },
      reasoning_effort: selectedEffort,
    }
    : nextPayload;
}
