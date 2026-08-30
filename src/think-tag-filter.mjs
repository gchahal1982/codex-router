import { Transform } from "node:stream";

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

function couldBeOpeningTag(value) {
  const candidate = value.trimStart();
  return OPEN_TAG.startsWith(candidate);
}

// Some OpenAI-compatible reasoning models serialize private thought inside the
// ordinary content field as a leading <think>...</think> block. LiteLLM cannot
// distinguish that from the answer, so Codex renders it verbatim. This stateful
// filter discards only a leading thought block; tags appearing later in a real
// answer remain untouched.
export function filterThinkDelta(state, value) {
  if (typeof value !== "string" || value.length === 0) return value;
  if (state.mode === "answer") return value;

  state.pending += value;
  if (state.mode === "start") {
    const opening = state.pending.match(/^\s*<think>/);
    if (!opening) {
      if (couldBeOpeningTag(state.pending)) return "";
      state.mode = "answer";
      const answer = state.pending;
      state.pending = "";
      return answer;
    }
    state.mode = "thinking";
    state.pending = state.pending.slice(opening[0].length);
  }

  const closing = state.pending.indexOf(CLOSE_TAG);
  if (closing === -1) {
    // Retain only the longest possible partial closing tag across chunks. The
    // thought itself is intentionally not buffered in memory or forwarded.
    state.pending = state.pending.slice(-(CLOSE_TAG.length - 1));
    return "";
  }
  state.mode = "answer";
  const answer = state.pending.slice(closing + CLOSE_TAG.length).replace(/^\s+/, "");
  state.pending = "";
  return answer;
}

export function stripLeadingThinkBlock(value) {
  if (typeof value !== "string") return value;
  return value.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, "");
}

function filterChoice(choice, state) {
  if (typeof choice?.delta?.content === "string") {
    choice.delta.content = filterThinkDelta(state, choice.delta.content);
  }
  if (typeof choice?.message?.content === "string") {
    choice.message.content = stripLeadingThinkBlock(choice.message.content);
  }
}

function filterPayload(payload, states) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.choices)) return payload;
  payload.choices.forEach((choice, ordinal) => {
    const key = Number.isInteger(choice?.index) ? choice.index : ordinal;
    let state = states.get(key);
    if (!state) {
      state = { mode: "start", pending: "" };
      states.set(key, state);
    }
    filterChoice(choice, state);
  });
  return payload;
}

function eventStreamTransform() {
  const states = new Map();
  let buffered = "";
  return new Transform({
    transform(chunk, _encoding, callback) {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() || "";
      for (const line of lines) {
        const match = line.match(/^(data:\s*)(.*)$/);
        if (!match || match[2] === "[DONE]") {
          this.push(`${line}\n`);
          continue;
        }
        try {
          const payload = filterPayload(JSON.parse(match[2]), states);
          this.push(`${match[1]}${JSON.stringify(payload)}\n`);
        } catch {
          this.push(`${line}\n`);
        }
      }
      callback();
    },
    flush(callback) {
      if (buffered) this.push(buffered);
      callback();
    },
  });
}

function jsonTransform() {
  const chunks = [];
  return new Transform({
    transform(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
    flush(callback) {
      const body = Buffer.concat(chunks);
      try {
        const payload = filterPayload(JSON.parse(body.toString("utf8")), new Map());
        this.push(JSON.stringify(payload));
      } catch {
        this.push(body);
      }
      callback();
    },
  });
}

export function createThinkTagFilter(contentType) {
  return String(contentType || "").toLowerCase().includes("text/event-stream")
    ? eventStreamTransform()
    : jsonTransform();
}
