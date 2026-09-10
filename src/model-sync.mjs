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
      chatEffort: typeof parsed.chatEffort === "string" ? parsed.chatEffort : undefined,
      cronEffort: typeof parsed.cronEffort === "string" ? parsed.cronEffort : undefined,
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

function writeSettings(settings) {
  const directory = path.dirname(MODEL_SYNC_PATH);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = `${MODEL_SYNC_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ version: 2, ...settings }, null, 2)}\n`, {
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
  const next = { enabled: true, selectedModel: settings.selectedModel, observedModels: settings.observedModels };
  for (const key of ["chatModel", "cronModel", "chatEffort", "cronEffort"]) if (settings[key]) next[key] = settings[key];
  if (chatEffort !== undefined) next.chatEffort = chatEffort || undefined;
  if (cronEffort !== undefined) next.cronEffort = cronEffort || undefined;
  writeSettings(next);
  return modelSyncSnapshot();
}

export function refreshModelSyncFromCodex() {
  const settings = readSettings();
  if (!settings.enabled) return modelSyncSnapshot();
  const rows = readObservedThreadRows();
  const observedModels = Object.fromEntries(rows.map((row) => [row.id, row.model]));
  const changed = rows
    .filter((row) => settings.observedModels[row.id] && settings.observedModels[row.id] !== row.model)
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const inventoryChanged = Object.keys(observedModels).length !== Object.keys(settings.observedModels).length;
  if (!changed.length && !inventoryChanged) return modelSyncSnapshot();
  const selectedModel = changed[0]?.model || settings.selectedModel;
  writeSettings({
    enabled: true,
    selectedModel,
    ...(settings.chatModel ? {
      chatModel: changed.length && settings.chatModel === settings.selectedModel
        ? selectedModel
        : settings.chatModel,
    } : {}),
    ...(settings.cronModel ? {
      cronModel: changed.length && settings.cronModel === settings.selectedModel
        ? selectedModel
        : settings.cronModel,
    } : {}),
    ...(settings.chatEffort ? { chatEffort: settings.chatEffort } : {}),
    ...(settings.cronEffort ? { cronEffort: settings.cronEffort } : {}),
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
  if (id && settings.cronModel) {
    try {
      const database = new DatabaseSync(CODEX_STATE_DATABASE_PATH, { readOnly: true });
      const row = database.prepare("select thread_source from threads where id = ? limit 1").get(id);
      database.close();
      if (row?.thread_source === "automation") {
        selectedModel = settings.cronModel;
        selectedEffort = settings.cronEffort || selectedEffort;
      }
    } catch {}
  }
  if (!selectedModel || !incomingModel) return payload;

  const observedModel = id ? settings.observedModels[id] : undefined;
  if (id && observedModel && observedModel !== incomingModel) {
    // The app changed this thread's persisted model since synchronization was
    // enabled. That is the reliable picker event; ordinary turns keep sending
    // the same per-thread value and must not steal the global selection back.
    selectedModel = incomingModel;
    writeSettings({
      enabled: true,
      selectedModel,
      ...(settings.chatModel ? {
        chatModel: settings.chatModel === settings.selectedModel ? selectedModel : settings.chatModel,
      } : {}),
      ...(settings.cronModel ? {
        cronModel: settings.cronModel === settings.selectedModel ? selectedModel : settings.cronModel,
      } : {}),
      ...(settings.chatEffort ? { chatEffort: settings.chatEffort } : {}),
      ...(settings.cronEffort ? { cronEffort: settings.cronEffort } : {}),
      observedModels: { ...settings.observedModels, [id]: incomingModel },
    });
    return payload;
  }
  if (id && !observedModel) {
    writeSettings({
      enabled: true,
      selectedModel,
      ...(settings.chatModel ? { chatModel: settings.chatModel } : {}),
      ...(settings.cronModel ? { cronModel: settings.cronModel } : {}),
      ...(settings.chatEffort ? { chatEffort: settings.chatEffort } : {}),
      ...(settings.cronEffort ? { cronEffort: settings.cronEffort } : {}),
      observedModels: { ...settings.observedModels, [id]: incomingModel },
    });
  }
  const nextPayload = incomingModel === selectedModel ? payload : { ...payload, model: selectedModel };
  return selectedEffort && typeof nextPayload === "object"
    ? {
      ...nextPayload,
      reasoning: { ...(nextPayload.reasoning || {}), effort: selectedEffort },
    }
    : nextPayload;
}
