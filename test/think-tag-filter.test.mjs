import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  createThinkTagFilter,
  filterThinkDelta,
  stripLeadingThinkBlock,
} from "../src/think-tag-filter.mjs";

async function transformed(chunks, contentType) {
  const output = [];
  for await (const chunk of Readable.from(chunks).pipe(createThinkTagFilter(contentType))) {
    output.push(Buffer.from(chunk));
  }
  return Buffer.concat(output).toString("utf8");
}

test("stream filter removes a leading thought block split across arbitrary chunks", () => {
  const state = { mode: "start", pending: "" };
  assert.equal(filterThinkDelta(state, "<thi"), "");
  assert.equal(filterThinkDelta(state, "nk>private reasoning</thi"), "");
  assert.equal(filterThinkDelta(state, "nk>\nVisible answer"), "Visible answer");
  assert.equal(filterThinkDelta(state, " with <think>literal XML</think>"), " with <think>literal XML</think>");
});

test("JSON filter removes private thought but preserves the visible answer", async () => {
  const body = JSON.stringify({
    choices: [{ message: { role: "assistant", content: "<think>private</think>\nFinal answer" } }],
  });
  const result = JSON.parse(await transformed([body], "application/json"));
  assert.equal(result.choices[0].message.content, "Final answer");
});

test("SSE filter removes thought tags without buffering the answer stream", async () => {
  const stream = await transformed([
    'data: {"choices":[{"index":0,"delta":{"content":"<think>hidden"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":" text</think>Visible"}}]}\n\n',
    'data: [DONE]\n\n',
  ], "text/event-stream");
  assert.doesNotMatch(stream, /hidden|<think>|<\/think>/);
  assert.match(stream, /Visible/);
  assert.match(stream, /data: \[DONE\]/);
});

test("plain answers and later literal think tags are preserved", () => {
  assert.equal(stripLeadingThinkBlock("Plain answer <think>example</think>"), "Plain answer <think>example</think>");
  assert.equal(stripLeadingThinkBlock("<think>private</think>Answer"), "Answer");
});
