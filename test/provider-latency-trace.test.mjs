import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("provider latency traces keep content-free correlated attempts", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "router-latency-"));
  const previous = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const telemetry = await import(`../src/provider-latency-trace.mjs?test=${Date.now()}`);
    const trace = telemetry.createProviderLatencyTrace({ requestedModel: "asked-model" });
    trace.setResolvedModel("resolved-model");
    const callbacks = trace.fetchCallbacks({ provider: "openrouter", model: "resolved-model" });
    callbacks.onAttemptStart({ attempt: 1 });
    callbacks.onAttemptFinish({ attempt: 1, response: { status: 503 } });
    callbacks.onAttemptStart({ attempt: 2 });
    callbacks.onAttemptFinish({ attempt: 2, response: { status: 200 } });
    trace.markSemantic();
    trace.setReturnedModel("returned-model");
    trace.finish({ statusCode: 200 });

    const record = JSON.parse(readFileSync(telemetry.PROVIDER_LATENCY_TRACES_PATH, "utf8"));
    assert.match(
      record.logicalRequestId,
      /^router-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(record.requestedModel, "asked-model");
    assert.equal(record.resolvedModel, "resolved-model");
    assert.equal(record.returnedModel, "returned-model");
    assert.deepEqual(record.attempts.map((attempt) => attempt.attemptNumber), [1, 2]);
    assert.deepEqual(record.attempts.map((attempt) => attempt.status), ["http_503", "http_200"]);
    assert.ok(Number.isInteger(record.attempts[1].firstSemanticEventMs));
    assert.equal("prompt" in record, false);
    assert.equal("headers" in record, false);
    assert.deepEqual(trace.correlationHeaders(), {
      "X-Codex-Router-Request-Id": record.logicalRequestId,
    });
    const inherited = telemetry.createProviderLatencyTrace({
      logicalRequestId: record.logicalRequestId,
    });
    assert.equal(inherited.logicalRequestId, record.logicalRequestId);
    const rejected = telemetry.createProviderLatencyTrace({
      logicalRequestId: "attacker-controlled",
    });
    assert.notEqual(rejected.logicalRequestId, "attacker-controlled");
    if (process.platform !== "win32") {
      assert.equal(statSync(telemetry.PROVIDER_LATENCY_TRACES_PATH).mode & 0o777, 0o600);
    }
  } finally {
    if (previous === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previous;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
