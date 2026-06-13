// End-to-end pipeline tests: transform → normalize → cache, in the exact order
// src/server.js applies them. Guards the Remote Control failure modes that
// span multiple stages.
//
// Run: node test/pipeline.test.mjs

import { transform } from "../src/transforms/default.js";
import { normalizeMessageStructure } from "../src/normalize.js";
import {
  injectBreakpointIfAbsent,
  normalizeTailBreakpoints,
  rewriteCacheControl,
  stripIntermediateMessageBreakpoints,
} from "../src/cache.js";

let failures = 0;

function runPipeline(body) {
  transform(body);
  normalizeMessageStructure(body);
  stripIntermediateMessageBreakpoints(body);
  const { tailBlocks } = injectBreakpointIfAbsent(body, { tailTtl: "5m" });
  const clientTail = normalizeTailBreakpoints(body, "5m");
  const skip = new Set([...tailBlocks, ...clientTail]);
  rewriteCacheControl(body, { rewritten: 0, alreadySet: 0, skipped: 0 }, skip);
  return body;
}

function allText(body) {
  return body.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : [{ text: m.content }]))
    .map((b) => (b && typeof b.text === "string" ? b.text : ""))
    .join("\n");
}

function assert(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) {
    failures += 1;
    if (detail) console.log(`        ! ${detail}`);
  }
}

// --- The reported failure: a Remote Control steer is destroyed -------------
//
// Claude Code welds the steer onto the breadcrumb in one block, and appends a
// trailing `system` hook so the steer is no longer the last message. The old
// transform dropped the whole block; the user's "Test" must survive.
{
  const body = {
    model: "claude-opus-4-8",
    messages: [
      { role: "user", content: [{ type: "text", text: "earlier question" }] },
      { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>Message sent at Sat 2026-06-13 14:27:25 UTC.</system-reminder>\nTest" },
        ],
      },
      { role: "system", content: [{ type: "text", text: "UserPromptSubmit hook success: OK" }] },
    ],
  };
  runPipeline(body);
  const text = allText(body);
  assert("remote steer text survives the pipeline", /(^|\n)\s*Test\s*($|\n)/.test(text), `text=${JSON.stringify(text)}`);
  assert(
    "breadcrumb scaffolding is shed",
    !text.includes("<system-reminder>Message sent at"),
    "breadcrumb markup leaked through",
  );
  const last = body.messages[body.messages.length - 1];
  assert("conversation does not end in assistant", last.role !== "assistant", `ends in ${last.role}`);
}

// --- A pure reminder block is still dropped from history (token savings) ----
{
  const body = {
    model: "claude-opus-4-8",
    messages: [
      { role: "user", content: [
        { type: "text", text: "<system-reminder>big stale CLAUDE-ish reminder with no user text</system-reminder>" },
        { type: "text", text: "the real question" },
      ] },
      { role: "assistant", content: [{ type: "text", text: "a" }] },
      { role: "user", content: [{ type: "text", text: "tail" }] },
    ],
  };
  runPipeline(body);
  const text = allText(body);
  assert("pure reminder dropped from history", !text.includes("big stale CLAUDE-ish reminder"), text);
  assert("sibling user text kept", text.includes("the real question"), text);
}

console.log("");
if (failures > 0) {
  console.log(`${failures} test(s) FAILED`);
  process.exit(1);
}
console.log("all pipeline tests passed");
