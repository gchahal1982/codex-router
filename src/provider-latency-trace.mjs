import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { STATE_DIR } from "./paths.mjs";

export const PROVIDER_LATENCY_TRACES_PATH = path.join(
  STATE_DIR,
  "provider-latency-traces.jsonl",
);

const ROUTER_ID = /^router-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function boundedText(value, fallback = "unknown") {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, 160);
}

function elapsedMs(startedAt) {
  return Math.max(0, Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6));
}

function writeTrace(record) {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(PROVIDER_LATENCY_TRACES_PATH, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(PROVIDER_LATENCY_TRACES_PATH, 0o600);
  } catch {
    // Observation-only telemetry must never fail a model request.
  }
}

export function validRouterCorrelationId(value) {
  return typeof value === "string" && ROUTER_ID.test(value);
}

export function createProviderLatencyTrace({
  requestedModel,
  routeClass = "inference",
  logicalRequestId: inheritedId,
} = {}) {
  const startedAt = process.hrtime.bigint();
  const startedWallAt = Date.now();
  const logicalRequestId = validRouterCorrelationId(inheritedId)
    ? inheritedId
    : `router-${randomUUID()}`;
  const attempts = [];
  let nextAttemptNumber = 0;
  let requested = boundedText(requestedModel);
  let payloadClass = "ordinary";
  let resolvedModel;
  let returnedModel;
  let status = "pending";
  let errorCode;
  let finished = false;

  function beginAttempt({
    provider,
    model,
    kind = "generation",
    accountPseudonym,
  } = {}) {
    const attempt = {
      upstreamAttemptId: `attempt-${randomUUID()}`,
      attemptNumber: ++nextAttemptNumber,
      provider: boundedText(provider),
      model: boundedText(model),
      kind: boundedText(kind),
      ...(accountPseudonym
        ? { accountPseudonym: boundedText(accountPseudonym) }
        : {}),
      startedMs: elapsedMs(startedAt),
      status: "pending",
    };
    attempts.push(attempt);
    return attempt;
  }

  function fetchCallbacks(metadata) {
    const active = new Map();
    return {
      onAttemptStart({ attempt }) {
        active.set(attempt, beginAttempt(metadata));
      },
      onAttemptFinish({ attempt, response, error }) {
        const record = active.get(attempt);
        if (!record) return;
        if (response) record.upstreamHeadersMs = elapsedMs(startedAt);
        record.status = response ? `http_${response.status}` : "transport_error";
        if (!response || response.status < 200 || response.status >= 300) {
          record.streamCompleteMs = elapsedMs(startedAt);
        }
        if (error) record.errorCode = boundedText(error.cause?.code || error.name || "Error");
      },
    };
  }

  function markSemantic(at = Date.now()) {
    const attempt = [...attempts].reverse().find((candidate) => /^http_2\d\d$/.test(candidate.status));
    if (!attempt || attempt.firstSemanticEventMs !== undefined) return;
    const wallElapsed = Math.max(0, at - startedWallAt);
    attempt.firstSemanticEventMs = Math.round(wallElapsed);
  }

  function markFirstFrame(at = Date.now()) {
    const attempt = [...attempts].reverse().find((candidate) => /^http_2\d\d$/.test(candidate.status));
    if (!attempt || attempt.firstUpstreamFrameMs !== undefined) return;
    attempt.firstUpstreamFrameMs = Math.max(0, Math.round(at - startedWallAt));
  }

  function finishAttempt(statusCode) {
    const attempt = attempts.at(-1);
    if (!attempt || attempt.streamCompleteMs !== undefined) return;
    attempt.streamCompleteMs = elapsedMs(startedAt);
    if (attempt.status === "pending") attempt.status = `http_${statusCode || 0}`;
  }

  function finish({ statusCode, error } = {}) {
    if (finished) return;
    finished = true;
    finishAttempt(statusCode);
    status = statusCode >= 200 && statusCode < 400 ? "success" : statusCode === 0 ? "cancelled" : "error";
    errorCode = error ? boundedText(error.cause?.code || error.code || error.name || "Error") : undefined;
    writeTrace(snapshot());
  }

  function snapshot() {
    return {
      schemaVersion: 1,
      at: new Date().toISOString(),
      logicalRequestId,
      routeClass: boundedText(routeClass),
      requestedModel: requested,
      payloadClass,
      ...(resolvedModel ? { resolvedModel } : {}),
      ...(returnedModel ? { returnedModel } : {}),
      durationMs: elapsedMs(startedAt),
      ...(attempts[0] ? { routerPreUpstreamMs: attempts[0].startedMs } : {}),
      status,
      ...(errorCode ? { errorCode } : {}),
      attempts: attempts.map((attempt) => ({ ...attempt })),
    };
  }

  return {
    logicalRequestId,
    beginAttempt,
    finishAttemptRecord(attempt, { response, error } = {}) {
      if (!attempt) return;
      if (response) attempt.upstreamHeadersMs = elapsedMs(startedAt);
      attempt.status = response ? `http_${response.status}` : "transport_error";
      if (!response || response.status < 200 || response.status >= 300) {
        attempt.streamCompleteMs = elapsedMs(startedAt);
      }
      if (error) attempt.errorCode = boundedText(error.cause?.code || error.name || "Error");
    },
    fetchCallbacks,
    markSemantic,
    markFirstFrame,
    finishAttempt,
    finish,
    snapshot,
    setResolvedModel(model) {
      resolvedModel = boundedText(model);
    },
    setRequestedModel(model) {
      requested = boundedText(model);
    },
    setPayloadClass(value) {
      payloadClass = boundedText(value, "ordinary");
    },
    setReturnedModel(model) {
      returnedModel = boundedText(model);
    },
    correlationHeaders() {
      return { "X-Codex-Router-Request-Id": logicalRequestId };
    },
  };
}
