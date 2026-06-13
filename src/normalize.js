// Structural normalization for /v1/messages bodies.
//
// The Anthropic Messages API enforces an ordering rule for mid-conversation
// `system` messages (the `role: "system"` entries that can appear *inside*
// `body.messages`, distinct from the top-level `body.system` prompt):
//
//   a `system` message must immediately follow a `user` message, OR an
//   `assistant` message whose last content block is a `tool_result`.
//
// Violating it yields: 400 messages.<i>: role 'system' must follow a 'user'
// message or an 'assistant' message ending in a server tool result.
//
// Claude Code's Remote Control injects a mid-conversation `system` breadcrumb
// ("Message sent at ...") when you steer a session from web/mobile. If your
// previous turn ended in plain assistant text (not a tool_result), that
// breadcrumb is already in an invalid slot — and pino's own history trimming
// (restructureV123) can also strand a surviving `system` message after
// dropping/reordering its neighbours. A proxy that rewrites message history
// must not emit a structurally-invalid array, so we repair it here.
//
// Repair strategy (lossless): fold the offending `system` message's content
// into the *next* `user` message (prepended), falling back to the previous
// `user` message (appended); if there is no `user` neighbour at all, demote
// the message to `user` in place. This restores valid alternation while
// preserving the breadcrumb text, exactly as Claude Code represented these
// reminders before the mid-conversation-system beta existed.

function toBlocks(content) {
  if (Array.isArray(content)) return content;
  if (typeof content === "string" && content.length > 0) {
    return [{ type: "text", text: content }];
  }
  return [];
}

function endsInToolResult(msg) {
  if (!msg || msg.role !== "assistant") return false;
  const c = msg.content;
  const last = Array.isArray(c) ? c[c.length - 1] : null;
  return Boolean(last) && last.type === "tool_result";
}

// Returns the number of system messages relocated. Mutates body.messages.
export function normalizeMessageStructure(body) {
  if (!body || !Array.isArray(body.messages)) return 0;
  const msgs = body.messages;
  let folded = 0;

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || m.role !== "system") continue;

    const prev = i > 0 ? msgs[i - 1] : null;
    if (prev && (prev.role === "user" || endsInToolResult(prev))) continue; // already valid

    const blocks = toBlocks(m.content);

    // Prefer folding forward into the next user message (without reaching across
    // an assistant turn): this keeps the breadcrumb adjacent to the steer that
    // triggered it and removes the stray `system` message cleanly.
    let nextUser = null;
    for (let j = i + 1; j < msgs.length; j++) {
      if (msgs[j].role === "user") {
        nextUser = msgs[j];
        break;
      }
      if (msgs[j].role === "assistant") break;
    }

    if (nextUser) {
      nextUser.content = [...blocks, ...toBlocks(nextUser.content)];
      msgs.splice(i, 1);
      i -= 1;
    } else {
      // No following user to fold into (the system message is at the tail, or is
      // only followed by an assistant turn). Demote it to a `user` message *in
      // place* rather than splicing it backward — splicing would expose the
      // preceding assistant turn as the tail and trip the API's "conversation
      // must end with a user message" / no-assistant-prefill rule.
      m.role = "user";
      m.content = blocks;
    }
    folded += 1;
  }

  return folded;
}
