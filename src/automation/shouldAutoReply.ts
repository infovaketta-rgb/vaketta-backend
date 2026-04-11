export type AutoReplyMode = "OFF" | "DAY" | "NIGHT";

export function shouldAutoReply(
  config: {
    autoReplyEnabled: boolean;
    businessStartHour: number;
    businessEndHour: number;
    timezone: string;
  },
  lastHandledByStaff: boolean
): AutoReplyMode {
  if (!config.autoReplyEnabled) return "OFF";
  if (lastHandledByStaff) return "OFF";

  // Bug 4: use hotel timezone instead of server local time
  let hour: number;
  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: config.timezone,
    }).format(new Date());
    hour = parseInt(formatted, 10);
  } catch {
    // Fallback to UTC if timezone string is invalid
    hour = new Date().getUTCHours();
  }

  if (hour < config.businessStartHour || hour >= config.businessEndHour) {
    return "NIGHT";
  }

  return "DAY";
}
