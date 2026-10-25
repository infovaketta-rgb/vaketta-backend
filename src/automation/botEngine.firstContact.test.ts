/**
 * First-contact routing in botEngine.processMessage.
 *
 * Regression: an IDLE session (new guest, or one reset after a flow / INFO item /
 * 2-hour idle) used to return the menu for ANY input, so a guest's opening
 * question ("Can I talk to a staff") was dropped and only a repeat reached AI.
 *
 * Every I/O module botEngine touches is mocked — no Prisma, Redis, Meta or LLM.
 * The menu is observed via buildMenuMessage (plain-text path) / sendOutbound
 * (interactive-list path); the AI via getAIReply.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  session:           { state: "IDLE", data: {} as any, updatedAt: new Date() },
  hotelCfg:          {} as Record<string, unknown> | null,
  // When set, config is resolved PER hotelId (tenant-isolation tests).
  cfgByHotel:        null as Record<string, Record<string, unknown>> | null,
  menuItem:          null as any,
  flow:              null as any,
  getOrCreateSession: vi.fn(),
  updateSession:      vi.fn(),
  resetSession:       vi.fn(),
  getAIReply:         vi.fn(),
  isAIReplyOverQuota: vi.fn(),
  incrementAIUsage:   vi.fn(),
  executeFlowStep:    vi.fn(),
  buildMenuMessage:   vi.fn(),
  buildMenuListPayload: vi.fn(),
  sendOutbound:       vi.fn(),
  guestUpdateMany:    vi.fn(),
  menuItemFindFirst:  vi.fn(),
}));

vi.mock("../db/connect", () => ({
  default: {
    hotelMenuItem:  { findFirst: (...a: any[]) => m.menuItemFindFirst(...a) },
    flowDefinition: { findUnique: async () => m.flow },
    guest:          { updateMany: (...a: any[]) => m.guestUpdateMany(...a) },
  },
}));
vi.mock("../services/session.service", () => ({
  getOrCreateSession: (...a: any[]) => m.getOrCreateSession(...a),
  updateSession:      (...a: any[]) => m.updateSession(...a),
  resetSession:       (...a: any[]) => m.resetSession(...a),
}));
vi.mock("../services/settings.service", () => ({
  getHotelConfigCached: async (hotelId: string) =>
    m.cfgByHotel ? (m.cfgByHotel[hotelId] ?? null) : m.hotelCfg,
}));
vi.mock("./flowRuntime", () => ({
  executeFlowStep: (...a: any[]) => m.executeFlowStep(...a),
}));
vi.mock("../services/ai.service", () => ({
  getAIReply: (...a: any[]) => m.getAIReply(...a),
}));
vi.mock("../services/usage.service", () => ({
  incrementAIUsage:   (...a: any[]) => m.incrementAIUsage(...a),
  isAIReplyOverQuota: (...a: any[]) => m.isAIReplyOverQuota(...a),
}));
vi.mock("./buildMenuResponse", () => ({
  buildMenuMessage:     (...a: any[]) => m.buildMenuMessage(...a),
  buildMenuListPayload: (...a: any[]) => m.buildMenuListPayload(...a),
}));
vi.mock("../services/outbound/outbound.service", () => ({
  sendOutbound: (...a: any[]) => m.sendOutbound(...a),
}));

import { processMessage } from "./botEngine";
import { isGreeting } from "./greeting";
import { isInteractivePayloadId } from "./interactivePayload";
import { CONFIRM_BTN_ID, MODIFY_BTN_ID, CANCEL_BTN_ID } from "./nodes/ara/constants";
import { MOD_ADD_EXTRA_BED, MODIFY_DONE, EDIT_ROOM_PREFIX, ADD_ROOM_PREFIX, MOVE_TO_ROOM_PREFIX, CHANGE_TYPE_PREFIX } from "./nodes/modifyLists";

const ROOM_UUID = "3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c";

const HOTEL = "hotel_a";
const GUEST = "guest_1";
const MENU  = "Welcome!\n1. Book a room\n2. Talk to staff";

beforeEach(() => {
  vi.clearAllMocks();
  m.session  = { state: "IDLE", data: {}, updatedAt: new Date() };
  m.hotelCfg = { aiEnabled: true, botMessages: {} };
  m.cfgByHotel = null;
  m.menuItem = null;
  m.flow     = null;
  m.getOrCreateSession.mockImplementation(async () => ({ ...m.session }));
  m.updateSession.mockResolvedValue(undefined);
  m.resetSession.mockResolvedValue(undefined);
  m.menuItemFindFirst.mockImplementation(async () => m.menuItem);
  m.isAIReplyOverQuota.mockResolvedValue(false);
  m.incrementAIUsage.mockResolvedValue(undefined);
  m.getAIReply.mockResolvedValue({ text: "AI answer", handoff: false });
  m.buildMenuMessage.mockResolvedValue(MENU);
  m.buildMenuListPayload.mockResolvedValue(null);
  m.executeFlowStep.mockResolvedValue("flow reply");
  m.guestUpdateMany.mockResolvedValue({ count: 1 });
});

const menuShown = () => m.buildMenuMessage.mock.calls.length > 0 || m.sendOutbound.mock.calls.length > 0;

// ── isGreeting (pure) ─────────────────────────────────────────────────────────
describe("isGreeting", () => {
  it.each(["hi", "Hi!", "hello", "Hello there", "hey 👋", "hii", "Good morning", "good evening team", "Namaste", "hi hello"])(
    "%s → greeting", (s) => expect(isGreeting(s)).toBe(true),
  );
  it.each([
    "Can I talk to a staff",
    "Hi, can I talk to a staff",
    "Hello I want to book a room",
    "Can we visit the property offline?",
    "good",
    "history",
    "1",
    "",
  ])("%s → not a greeting", (s) => expect(isGreeting(s)).toBe(false));
});

// ── First contact (IDLE) ──────────────────────────────────────────────────────
describe("first contact routes meaningful messages to AI", () => {
  it("FC1: first-contact staff request reaches the AI, not the menu", async () => {
    const reply = await processMessage(HOTEL, GUEST, "Can I talk to a staff");
    expect(m.getAIReply).toHaveBeenCalledWith(HOTEL, GUEST, "Can I talk to a staff");
    expect(reply).toBe("AI answer");
    expect(menuShown()).toBe(false);
    expect(m.updateSession).toHaveBeenCalledWith(GUEST, HOTEL, "AWAITING_SELECTION", {});
    expect(m.incrementAIUsage).toHaveBeenCalledWith(HOTEL);
  });

  it("FC1b: an AI handoff on first contact opens ENQUIRY_OPEN and flags the guest", async () => {
    m.getAIReply.mockResolvedValue({ text: "Connecting you to our team.", handoff: true });
    const reply = await processMessage(HOTEL, GUEST, "I am very unhappy, get me a manager");
    expect(reply).toBe("Connecting you to our team.");
    expect(m.guestUpdateMany).toHaveBeenCalledWith({ where: { id: GUEST, hotelId: HOTEL }, data: { lastHandledByStaff: true } });
    expect(m.updateSession).toHaveBeenCalledWith(GUEST, HOTEL, "ENQUIRY_OPEN", {});
  });

  it("FC2: first-contact offline-visit question reaches the AI", async () => {
    const reply = await processMessage(HOTEL, GUEST, "Can we visit the resort offline before booking?");
    expect(m.getAIReply).toHaveBeenCalledTimes(1);
    expect(reply).toBe("AI answer");
    expect(menuShown()).toBe(false);
  });

  it("FC8: a session previously reset to IDLE answers a question instead of re-showing the menu", async () => {
    // Same state a guest lands in after an INFO item, a finished flow, or MENU.
    m.session = { state: "IDLE", data: {}, updatedAt: new Date(Date.now() - 10 * 60 * 1000) };
    const reply = await processMessage(HOTEL, GUEST, "What time is check-out?");
    expect(reply).toBe("AI answer");
    expect(menuShown()).toBe(false);
  });

  it("FC8b: a session expired after 2h idle answers a question instead of showing the menu", async () => {
    m.session = { state: "AWAITING_SELECTION", data: {}, updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) };
    const reply = await processMessage(HOTEL, GUEST, "Is breakfast included?");
    expect(m.resetSession).toHaveBeenCalledWith(GUEST, HOTEL);
    expect(reply).toBe("AI answer");
    expect(menuShown()).toBe(false);
  });
});

// ── Greetings and explicit menu commands ──────────────────────────────────────
describe("greetings and menu commands still show the menu", () => {
  it.each(["Hi", "hello", "MENU", "Good morning!", "hey there"])("FC3: first-contact %s → menu, no AI", async (input) => {
    const reply = await processMessage(HOTEL, GUEST, input);
    expect(reply).toBe(MENU);
    expect(m.getAIReply).not.toHaveBeenCalled();
    expect(m.updateSession).toHaveBeenCalledWith(GUEST, HOTEL, "AWAITING_SELECTION", {});
  });

  it("FC3b: empty first-contact input → menu", async () => {
    expect(await processMessage(HOTEL, GUEST, "")).toBe(MENU);
    expect(m.getAIReply).not.toHaveBeenCalled();
  });

  it("FC3c: interactive list menu is still sent for a first-contact greeting", async () => {
    m.hotelCfg = { aiEnabled: true, botMessages: { menuUseListMessage: "true" } };
    m.buildMenuListPayload.mockResolvedValue({ bodyText: "Welcome", buttonLabel: "View Options", sections: [] });
    m.sendOutbound.mockResolvedValue({ sent: true });
    expect(await processMessage(HOTEL, GUEST, "Hi")).toBeNull();
    expect(m.sendOutbound).toHaveBeenCalledTimes(1);
    expect(m.getAIReply).not.toHaveBeenCalled();
  });

  it("FC3d: a menu flow (menuFlowId) still starts for a first-contact greeting", async () => {
    m.hotelCfg = { aiEnabled: true, menuFlowId: "flow_menu", botMessages: {} };
    m.flow = { id: "flow_menu", isActive: true, nodes: [{ id: "start1", type: "start" }] };
    expect(await processMessage(HOTEL, GUEST, "hello")).toBe("flow reply");
    expect(m.executeFlowStep.mock.calls[0]![2]).toBe("FLOW:flow_menu:start1");
    expect(m.getAIReply).not.toHaveBeenCalled();
  });

  it("FC3e: a greeting that is NOT first contact keeps its old route (AI)", async () => {
    m.session = { state: "AWAITING_SELECTION", data: {}, updatedAt: new Date() };
    expect(await processMessage(HOTEL, GUEST, "Good morning")).toBe("AI answer");
  });
});

// ── Booking ───────────────────────────────────────────────────────────────────
describe("booking routing", () => {
  it("FC4: a booking menu key on first contact enters the booking flow deterministically", async () => {
    m.menuItem = { key: "1", type: "BOOKING", flowId: "flow_book", replyText: null };
    m.flow = { id: "flow_book", isActive: true, nodes: [{ id: "s", type: "start" }] };
    expect(await processMessage(HOTEL, GUEST, "1")).toBe("flow reply");
    expect(m.executeFlowStep.mock.calls[0]![2]).toBe("FLOW:flow_book:s");
    expect(m.getAIReply).not.toHaveBeenCalled();
  });

  it("FC4b: free-text booking request on first contact goes to AI (no top-level booking classifier exists)", async () => {
    expect(await processMessage(HOTEL, GUEST, "I want to book a room for 2 nights")).toBe("AI answer");
    expect(m.executeFlowStep).not.toHaveBeenCalled();
  });
});

// ── AI unavailable → safe fallback ────────────────────────────────────────────
describe("first contact falls back to the welcome menu when AI can't answer", () => {
  const cases: Array<[string, () => void]> = [
    ["AI disabled",     () => { m.hotelCfg = { aiEnabled: false, botMessages: {} }; }],
    ["quota exceeded",  () => { m.isAIReplyOverQuota.mockResolvedValue(true); }],
    ["AI returns null", () => { m.getAIReply.mockResolvedValue(null); }],
    ["AI returns blank text", () => { m.getAIReply.mockResolvedValue({ text: "   ", handoff: false }); }],
  ];
  it.each(cases)("FC5: %s → plain welcome menu, no 'not recognised' preamble", async (_label, setup) => {
    setup();
    const reply = await processMessage(HOTEL, GUEST, "Can I talk to a staff");
    expect(reply).toBe(MENU);
    expect(reply).not.toMatch(/isn't recognised/);
    expect(m.incrementAIUsage).not.toHaveBeenCalled();
  });

  it("FC5b: quota exceeded never calls the LLM", async () => {
    m.isAIReplyOverQuota.mockResolvedValue(true);
    await processMessage(HOTEL, GUEST, "Can I talk to a staff");
    expect(m.getAIReply).not.toHaveBeenCalled();
  });

  it("FC5c: after first contact, the 'not recognised' fallback is unchanged", async () => {
    m.session = { state: "AWAITING_SELECTION", data: {}, updatedAt: new Date() };
    m.hotelCfg = { aiEnabled: false, botMessages: {} };
    expect(await processMessage(HOTEL, GUEST, "blah")).toBe(`Sorry, that option isn't recognised.\n\n${MENU}`);
  });
});

// ── Unchanged paths ───────────────────────────────────────────────────────────
describe("unchanged deterministic paths", () => {
  it("FC6: menu-key INFO selection returns its reply without AI", async () => {
    m.menuItem = { key: "3", type: "INFO", replyText: "We are at the beach." };
    expect(await processMessage(HOTEL, GUEST, "3")).toBe("We are at the beach.\n\n_Reply *MENU* for other options._");
    expect(m.getAIReply).not.toHaveBeenCalled();
  });

  it("FC6b: menu-key ENQUIRY selection opens ENQUIRY_OPEN", async () => {
    m.menuItem = { key: "2", type: "ENQUIRY", replyText: "Our team will reply." };
    const reply = await processMessage(HOTEL, GUEST, "2");
    expect(reply).toContain("Our team will reply.");
    expect(m.updateSession).toHaveBeenCalledWith(GUEST, HOTEL, "ENQUIRY_OPEN", {});
    expect(m.getAIReply).not.toHaveBeenCalled();
  });

  it("FC7: an active flow delegates to executeFlowStep untouched", async () => {
    m.session = { state: "FLOW:f1:n1", data: { flow: { flowId: "f1", flowVars: {} } }, updatedAt: new Date() };
    expect(await processMessage(HOTEL, GUEST, "Can I talk to a staff")).toBe("flow reply");
    expect(m.executeFlowStep).toHaveBeenCalledWith(HOTEL, GUEST, "FLOW:f1:n1", m.session.data, "Can I talk to a staff", "WHATSAPP");
    expect(m.getAIReply).not.toHaveBeenCalled();
  });

  it("FC7b: ENQUIRY_OPEN stays silent", async () => {
    m.session = { state: "ENQUIRY_OPEN", data: {}, updatedAt: new Date() };
    expect(await processMessage(HOTEL, GUEST, "hello?")).toBeNull();
    expect(m.getAIReply).not.toHaveBeenCalled();
    expect(menuShown()).toBe(false);
  });

});

// ── Tenant isolation ──────────────────────────────────────────────────────────
describe("tenant isolation", () => {
  it("FC9: two hotels with different AI settings each follow their own config", async () => {
    m.cfgByHotel = {
      hotel_a: { aiEnabled: true,  botMessages: {} },
      hotel_b: { aiEnabled: false, botMessages: {} },
    };
    // Both guests are on first contact, same message, interleaved.
    const a1 = await processMessage("hotel_a", "guest_a", "Can I talk to a staff");
    const b1 = await processMessage("hotel_b", "guest_b", "Can I talk to a staff");
    const a2 = await processMessage("hotel_a", "guest_a", "Do you have parking?");

    expect(a1).toBe("AI answer");
    expect(a2).toBe("AI answer");
    expect(b1).toBe(MENU);

    // AI and quota were only ever consulted for hotel_a, with hotel_a's guest.
    expect(m.getAIReply.mock.calls.map((c) => c.slice(0, 2))).toEqual([["hotel_a", "guest_a"], ["hotel_a", "guest_a"]]);
    expect(m.isAIReplyOverQuota.mock.calls.every((c) => c[0] === "hotel_a")).toBe(true);
    expect(m.incrementAIUsage.mock.calls.every((c) => c[0] === "hotel_a")).toBe(true);
    // hotel_b's menu was built for hotel_b, and its session writes target hotel_b.
    expect(m.buildMenuMessage).toHaveBeenCalledWith("hotel_b");
    expect(m.buildMenuMessage).not.toHaveBeenCalledWith("hotel_a");
    expect(m.updateSession).toHaveBeenCalledWith("guest_b", "hotel_b", "AWAITING_SELECTION", {});
  });

  it("FC9b: a hotel with AI over quota does not affect another hotel's AI", async () => {
    m.cfgByHotel = {
      hotel_a: { aiEnabled: true, botMessages: {} },
      hotel_b: { aiEnabled: true, botMessages: {} },
    };
    m.isAIReplyOverQuota.mockImplementation(async (h: string) => h === "hotel_b");
    expect(await processMessage("hotel_b", "guest_b", "Is the pool open?")).toBe(MENU);
    expect(await processMessage("hotel_a", "guest_a", "Is the pool open?")).toBe("AI answer");
    expect(m.getAIReply).toHaveBeenCalledTimes(1);
    expect(m.getAIReply).toHaveBeenCalledWith("hotel_a", "guest_a", "Is the pool open?");
  });
});

// ── Blank AI text + handoff ───────────────────────────────────────────────────
describe("AI handoff with blank text", () => {
  it("FC10: token-only AI reply (blank text, handoff:true) still hands off and returns no text", async () => {
    m.getAIReply.mockResolvedValue({ text: "", handoff: true });
    const reply = await processMessage(HOTEL, GUEST, "This is unacceptable, I want a refund");
    // "" — not null and not a menu. message.service sends nothing for a falsy
    // reply (DAY mode), so no empty WhatsApp message goes out.
    expect(reply).toBe("");
    expect(m.guestUpdateMany).toHaveBeenCalledWith({ where: { id: GUEST, hotelId: HOTEL }, data: { lastHandledByStaff: true } });
    expect(m.updateSession).toHaveBeenCalledWith(GUEST, HOTEL, "ENQUIRY_OPEN", {});
    expect(m.updateSession).not.toHaveBeenCalledWith(GUEST, HOTEL, "AWAITING_SELECTION", {});
    // Ordering preserved: guest flagged before the session moves to ENQUIRY_OPEN.
    expect(m.guestUpdateMany.mock.invocationCallOrder[0]!).toBeLessThan(m.updateSession.mock.invocationCallOrder[0]!);
    expect(m.sendOutbound).not.toHaveBeenCalled();
    expect(m.buildMenuMessage).not.toHaveBeenCalled();
  });

  it("FC10b: blank text with handoff on a LATER message also hands off", async () => {
    m.session = { state: "AWAITING_SELECTION", data: {}, updatedAt: new Date() };
    m.getAIReply.mockResolvedValue({ text: "  ", handoff: true });
    // Whitespace-only text is normalised to "" so it can't be sent as a message.
    expect(await processMessage(HOTEL, GUEST, "worst stay ever")).toBe("");
    expect(m.updateSession).toHaveBeenCalledWith(GUEST, HOTEL, "ENQUIRY_OPEN", {});
  });

  it("FC10c: blank text WITHOUT handoff on a later message keeps the 'not recognised' fallback", async () => {
    m.session = { state: "AWAITING_SELECTION", data: {}, updatedAt: new Date() };
    m.getAIReply.mockResolvedValue({ text: "", handoff: false });
    expect(await processMessage(HOTEL, GUEST, "hmm")).toBe(`Sorry, that option isn't recognised.\n\n${MENU}`);
    expect(m.incrementAIUsage).not.toHaveBeenCalled();
  });
});

// ── Stale interactive taps ────────────────────────────────────────────────────
describe("stale interactive payload ids on an IDLE session", () => {
  const staleIds = [
    "opt_2",
    "plan_1",
    `room_${ROOM_UUID}`,
    `room_TYPE:${ROOM_UUID}`,
    `photos_${ROOM_UUID}`,
    CONFIRM_BTN_ID,
    MODIFY_BTN_ID,
    CANCEL_BTN_ID,
    "MIX_IT_UP",
    MOD_ADD_EXTRA_BED,
    MODIFY_DONE,
    `${EDIT_ROOM_PREFIX}2`,
    `${MOVE_TO_ROOM_PREFIX}1`,
    `${ADD_ROOM_PREFIX}${ROOM_UUID}`,
    `${CHANGE_TYPE_PREFIX}${ROOM_UUID}`,
  ];

  it.each(staleIds)("FC11: %s on first contact → welcome menu, no AI", async (id) => {
    const reply = await processMessage(HOTEL, GUEST, id);
    expect(reply).toBe(MENU);
    expect(reply).not.toMatch(/isn't recognised/);
    expect(m.getAIReply).not.toHaveBeenCalled();
    expect(m.executeFlowStep).not.toHaveBeenCalled();
  });

  it("FC11b: a menu key that happens to look like an id still wins (menu lookup runs first)", async () => {
    m.menuItem = { key: "OPT_2", type: "INFO", replyText: "Spa hours 9–6." };
    expect(await processMessage(HOTEL, GUEST, "opt_2")).toBe("Spa hours 9–6.\n\n_Reply *MENU* for other options._");
  });

  it("FC11c: a stale id on a LATER message keeps its established route (AI)", async () => {
    m.session = { state: "AWAITING_SELECTION", data: {}, updatedAt: new Date() };
    expect(await processMessage(HOTEL, GUEST, "opt_2")).toBe("AI answer");
  });

  it("FC11d: a stale id inside an active flow is still handled by the flow", async () => {
    m.session = { state: "FLOW:f1:n1", data: { flow: { flowId: "f1", flowVars: {} } }, updatedAt: new Date() };
    expect(await processMessage(HOTEL, GUEST, "opt_2")).toBe("flow reply");
    expect(m.executeFlowStep).toHaveBeenCalledTimes(1);
  });

  it.each([
    "room_service please",
    "room_service",
    "is plan_1 cheaper?",
    "plan_one",
    "opt_",
    "photos_of_the_pool",
    "confirm booking",
    "confirm_booking",
  ])("FC11e: natural text %j is not treated as a payload id and reaches the AI", async (text) => {
    expect(isInteractivePayloadId(text)).toBe(false);
    expect(await processMessage(HOTEL, GUEST, text)).toBe("AI answer");
  });
});

// ── Greeting with an intent ───────────────────────────────────────────────────
it("FC12: 'Hi, can I talk to a staff?' on first contact is intent, not a greeting", async () => {
  expect(isGreeting("Hi, can I talk to a staff?")).toBe(false);
  const reply = await processMessage(HOTEL, GUEST, "Hi, can I talk to a staff?");
  expect(m.getAIReply).toHaveBeenCalledWith(HOTEL, GUEST, "Hi, can I talk to a staff?");
  expect(reply).toBe("AI answer");
  expect(menuShown()).toBe(false);
});
