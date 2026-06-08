import { describe, it, expect } from "vitest";
import { interpolate } from "./interpolate";

describe("interpolate — {{var}} resolution against flowVars", () => {
  // Mirrors the runtime shape: flowVars is a flat Record<string,string>, holding
  // the keys ARA writes (bookingTotal, roomCount, effective*, etc.) plus the
  // system-injected guestName.
  const flowVars: Record<string, string> = {
    guestName:         "Yusaf",
    bookingTotal:      "74000",
    roomCount:         "5",
    bookingNights:     "2",
    effectiveAdults:   "3",
    effectiveChildren: "2",
    promotedToAdult:   "1",
  };

  it("resolves a message template with bookingTotal, effectiveAdults, guestName", () => {
    const tpl = "Hi {{guestName}}! Your {{roomCount}} rooms for {{effectiveAdults}} adults total ₹{{bookingTotal}}.";
    expect(interpolate(tpl, flowVars)).toBe("Hi Yusaf! Your 5 rooms for 3 adults total ₹74000.");
  });

  it("resolves each declared output key individually", () => {
    expect(interpolate("{{bookingTotal}}",      flowVars)).toBe("74000");
    expect(interpolate("{{roomCount}}",         flowVars)).toBe("5");
    expect(interpolate("{{bookingNights}}",     flowVars)).toBe("2");
    expect(interpolate("{{effectiveChildren}}", flowVars)).toBe("2");
    expect(interpolate("{{promotedToAdult}}",   flowVars)).toBe("1");
  });

  it("leaves unknown keys as the literal token (visible to authors)", () => {
    expect(interpolate("total is {{bookingTotal}}, x is {{nope}}", flowVars))
      .toBe("total is 74000, x is {{nope}}");
  });

  it("supports dot-notation keys when a literal dotted key exists", () => {
    expect(interpolate("{{selectedRoom.name}}", { "selectedRoom.name": "Deluxe" })).toBe("Deluxe");
  });

  it("replaces every occurrence and leaves surrounding text intact", () => {
    expect(interpolate("{{roomCount}} + {{roomCount}}", flowVars)).toBe("5 + 5");
    expect(interpolate("no vars here", flowVars)).toBe("no vars here");
  });
});
