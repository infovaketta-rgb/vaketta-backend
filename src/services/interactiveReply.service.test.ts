/**
 * Unit tests for interactiveReply.service — the shared parser that turns a
 * Meta webhook/history message into { id, title } so the chat UI stores the
 * human-readable title in body while the flow engine keeps matching on the
 * payload id. Used by whatsapp.controller (live) and history.service (import).
 */

import { describe, it, expect } from "vitest";
import { extractInteractiveReply, buildReplyMetadata } from "./interactiveReply.service";

describe("extractInteractiveReply", () => {
  it("parses a list_reply with id, title and description", () => {
    const reply = extractInteractiveReply({
      type: "interactive",
      interactive: {
        type: "list_reply",
        list_reply: { id: "opt_2", title: "Deluxe Room", description: "Sea view, king bed" },
      },
    });
    expect(reply).toEqual({
      type: "list_reply",
      id: "opt_2",
      title: "Deluxe Room",
      description: "Sea view, king bed",
    });
  });

  it("parses a button_reply with id and title", () => {
    const reply = extractInteractiveReply({
      type: "interactive",
      interactive: {
        type: "button_reply",
        button_reply: { id: "plan_1", title: "Plan 1 — ₹5000" },
      },
    });
    expect(reply).toEqual({
      type: "button_reply",
      id: "plan_1",
      title: "Plan 1 — ₹5000",
      description: null,
    });
  });

  it("parses a carousel/template quick_reply (type button) with payload and text", () => {
    const reply = extractInteractiveReply({
      type: "button",
      button: { payload: "room_abc123", text: "Select Room" },
    });
    expect(reply).toEqual({
      type: "quick_reply",
      id: "room_abc123",
      title: "Select Room",
      description: null,
    });
  });

  it("falls back to a null title when Meta omits it", () => {
    const reply = extractInteractiveReply({
      type: "interactive",
      interactive: { type: "list_reply", list_reply: { id: "opt_1" } },
    });
    expect(reply).toEqual({ type: "list_reply", id: "opt_1", title: null, description: null });
  });

  it("returns null for replies without an id and for plain text", () => {
    expect(extractInteractiveReply({ type: "interactive", interactive: { type: "list_reply", list_reply: {} } })).toBeNull();
    expect(extractInteractiveReply({ type: "button", button: { text: "no payload" } })).toBeNull();
    expect(extractInteractiveReply({ type: "text", text: { body: "hello" } })).toBeNull();
    expect(extractInteractiveReply(undefined)).toBeNull();
  });

  it("returns null for OUTBOUND interactive sends (list/button messages, not replies)", () => {
    expect(extractInteractiveReply({
      type: "interactive",
      interactive: { type: "list", action: { button: "View Menu", sections: [] } },
    })).toBeNull();
    expect(extractInteractiveReply({
      type: "interactive",
      interactive: { type: "button", action: { buttons: [] } },
    })).toBeNull();
  });
});

describe("buildReplyMetadata", () => {
  it("namespaces the reply under interactiveReply", () => {
    const reply = { type: "list_reply" as const, id: "opt_3", title: "Suite", description: null };
    expect(buildReplyMetadata(reply)).toEqual({
      interactiveReply: { type: "list_reply", id: "opt_3", title: "Suite", description: null },
    });
  });
});
