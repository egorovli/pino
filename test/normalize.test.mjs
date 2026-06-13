// Regression tests for normalizeMessageStructure (src/normalize.js).
//
// Run: node test/normalize.test.mjs
//
// No test framework — zero-dep, matching the project. Exits non-zero on the
// first failure. Each case asserts the repaired array satisfies BOTH Messages
// API invariants that a body-rewriting proxy must guarantee on its output:
//
//   1. every mid-conversation `system` message immediately follows a `user`
//      message, or an `assistant` message ending in a `tool_result`;
//   2. the conversation does not end in an `assistant` message (no prefill);
//
// plus the tool-use structural rules that the repair must not break:
//
//   3. every assistant `tool_use` is immediately followed by a `user` message
//      whose content leads with `tool_result` block(s);
//   4. no `user` turn places a non-tool_result block ahead of a tool_result.

import { normalizeMessageStructure } from "../src/normalize.js";

let failures = 0;

function lastBlock(c) {
  return Array.isArray(c) ? c[c.length - 1] : null;
}

// Returns an array of invariant-violation strings for a messages body.
function validate(body) {
  const m = body.messages || [];
  const errs = [];

  for (let i = 0; i < m.length; i++) {
    const msg = m[i];
    const prev = i > 0 ? m[i - 1] : null;

    // (1) system ordering
    if (msg.role === "system") {
      const prevOk =
        prev &&
        (prev.role === "user" ||
          (prev.role === "assistant" && lastBlock(prev.content)?.type === "tool_result"));
      if (!prevOk) errs.push(`[${i}] system follows ${prev ? prev.role : "START"}`);
    }

    // (3) tool_use must be answered by the immediately-following user turn,
    //     leading with tool_result.
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const hasToolUse = msg.content.some((b) => b && b.type === "tool_use");
      if (hasToolUse) {
        const next = m[i + 1];
        const nextOk =
          next &&
          next.role === "user" &&
          Array.isArray(next.content) &&
          next.content[0]?.type === "tool_result";
        if (!nextOk) {
          errs.push(`[${i}] assistant tool_use not followed by user[tool_result,…]`);
        }
      }
    }

    // (4) no text/other block ahead of a tool_result within a user turn
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const tr = msg.content.findIndex((b) => b && b.type === "tool_result");
      if (tr > 0) errs.push(`[${i}] user has block before tool_result`);
    }
  }

  // (2) no trailing assistant
  if (m.length && m[m.length - 1].role === "assistant") errs.push("ends in assistant");

  return errs;
}

function check(name, body, expectRoles) {
  normalizeMessageStructure(body);
  const errs = validate(body);
  const roles = body.messages.map((x) => x.role).join(",");
  let ok = errs.length === 0;
  if (expectRoles && roles !== expectRoles) {
    ok = false;
    errs.push(`roles=${roles} expected=${expectRoles}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${roles})`);
  if (!ok) {
    failures += 1;
    for (const e of errs) console.log(`        ! ${e}`);
  }
}

const text = (t) => ({ type: "text", text: t });
const toolUse = (id) => ({ type: "tool_use", id, name: "Bash", input: {} });
const toolResult = (id) => ({ type: "tool_result", tool_use_id: id, content: "ok" });
const u = (...c) => ({ role: "user", content: c });
const a = (...c) => ({ role: "assistant", content: c });
const s = (t) => ({ role: "system", content: [text(t)] });

// --- documented cases (must keep passing) -----------------------------------

// trailing breadcrumb after a plain assistant turn → demote in place
check("tail breadcrumb after assistant", {
  messages: [u(text("hi")), a(text("ready")), s("Message sent at X")],
}, "user,assistant,user");

// mid breadcrumb after assistant, followed by a user steer → fold forward
check("mid breadcrumb then user steer", {
  messages: [u(text("hi")), a(text("resp")), s("Message sent at X"), u(text("next"))],
}, "user,assistant,user");

// already-valid: system after user → untouched
check("system after user (valid, untouched)", {
  messages: [u(text("hi")), s("Message sent at X"), a(text("ok")), u(text("bye"))],
}, "user,system,assistant,user");

// already-valid: trailing system after user → untouched (observed 200)
check("trailing system after user (valid)", {
  messages: [u(text("hi")), a(text("ok")), u(text("more")), s("Message sent at X")],
}, "user,assistant,user,system");

// system after assistant ending in tool_result (server tool) → untouched
check("system after assistant tool_result (valid)", {
  messages: [u(text("hi")), a(text("t"), toolResult("srv")), s("Message sent at X"), u(text("k"))],
}, "user,assistant,system,user");

// --- the regression the original fix missed ---------------------------------

// steer lands mid-tool: breadcrumb between tool_use and its tool_result.
// Must fold AFTER the leading tool_result, preserving adjacency + ordering.
check("breadcrumb mid tool-cycle (fold after tool_result)", {
  messages: [
    u(text("go")),
    a(text("calling"), toolUse("t1")),
    s("Message sent at X"),
    u(toolResult("t1"), text("steer text")),
  ],
}, "user,assistant,user");

// same, but the tool_result user had only the tool_result
check("breadcrumb mid tool-cycle, bare tool_result", {
  messages: [u(text("go")), a(toolUse("t1")), s("Message sent at X"), u(toolResult("t1"))],
}, "user,assistant,user");

// --- structural edge cases --------------------------------------------------

// system as the very first message (next is assistant) → demote in place
check("leading system before assistant", {
  messages: [s("Message sent at X"), a(text("hi")), u(text("ok"))],
}, "user,assistant,user");

// system as the very first message, next is user → fold forward
check("leading system before user", {
  messages: [s("Message sent at X"), u(text("hi"))],
}, "user");

// consecutive systems after an assistant text turn
check("consecutive systems after assistant", {
  messages: [u(text("hi")), a(text("a")), s("one"), s("two"), u(text("z"))],
}, "user,assistant,user");

// consecutive systems at the tail after assistant
check("consecutive systems at tail", {
  messages: [u(text("hi")), a(text("a")), s("one"), s("two")],
});

// string-form system content
check("string-form system content", {
  messages: [u(text("hi")), a(text("a")), { role: "system", content: "Message sent at X" }],
}, "user,assistant,user");

// no messages / non-array → no throw
check("empty messages", { messages: [] }, "");

console.log("");
if (failures > 0) {
  console.log(`${failures} test(s) FAILED`);
  process.exit(1);
}
console.log("all tests passed");
