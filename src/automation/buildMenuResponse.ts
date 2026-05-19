import prisma from "../db/connect";

type BotMessages = {
  menuGreeting?:         string;
  menuFooter?:           string;
  menuListButtonLabel?:  string;
  menuListSectionTitle?: string;
};

type MenuListRow     = { id: string; title: string };
type MenuListSection = { title: string; rows: MenuListRow[] };

export type MenuListPayload = {
  bodyText:    string;
  buttonLabel: string;
  sections:    MenuListSection[];
};

const TYPE_ICON: Record<string, string> = {
  BOOKING: "📅",
  ENQUIRY: "💬",
  INFO:    "ℹ️",
  FLOW:    "🔀",
};

export async function buildMenuMessage(hotelId: string): Promise<string | null> {
  const [menu, config] = await Promise.all([
    prisma.hotelMenu.findUnique({
      where: { hotelId, isActive: true },
      include: {
        hotel: { select: { name: true } },
        items: {
          where: { isActive: true },
          orderBy: { order: "asc" },
        },
      },
    }),
    prisma.hotelConfig.findUnique({ where: { hotelId } }),
  ]);

  if (!menu || !menu.items.length) return null;

  const botMsgs = (config?.botMessages as BotMessages) ?? {};

  const hotelName = menu.hotel?.name;
  const defaultGreeting = hotelName ? `Welcome to *${hotelName}*! 🏨` : `Hello! 👋`;
  const greeting = botMsgs.menuGreeting?.trim() ? botMsgs.menuGreeting.trim() : defaultGreeting;
  const footer   = botMsgs.menuFooter?.trim()
    ? botMsgs.menuFooter.trim()
    : `Reply with the number of your choice.\n_Type 'Hi' anytime to return here._`;

  const divider = `━━━━━━━━━━━━━━━━`;

  let text = `${greeting}\n\n*${menu.title}*\n\n${divider}\n`;

  for (const item of menu.items) {
    const icon = TYPE_ICON[item.type ?? "INFO"] ?? "ℹ️";
    text += `*${item.key}.* ${item.label}  ${icon}\n`;
  }

  text += `${divider}\n\n${footer}`;

  return text;
}

export async function buildMenuListPayload(hotelId: string): Promise<MenuListPayload | null> {
  const [menu, config] = await Promise.all([
    prisma.hotelMenu.findUnique({
      where: { hotelId, isActive: true },
      include: {
        hotel: { select: { name: true } },
        items: {
          where: { isActive: true },
          orderBy: { order: "asc" },
        },
      },
    }),
    prisma.hotelConfig.findUnique({ where: { hotelId } }),
  ]);

  if (!menu || !menu.items.length) return null;

  const botMsgs = (config?.botMessages as BotMessages) ?? {};

  const hotelName      = menu.hotel?.name;
  const defaultGreeting = hotelName ? `Welcome to *${hotelName}*! 🏨` : `Hello! 👋`;
  const bodyText       = botMsgs.menuGreeting?.trim() || defaultGreeting;
  const buttonLabel    = (botMsgs.menuListButtonLabel?.trim()  || "View Menu").slice(0, 20);
  const sectionTitle   = (botMsgs.menuListSectionTitle?.trim() || menu.title || "Our Services").slice(0, 24);

  const rows: MenuListRow[] = menu.items.map((item) => ({
    id:    item.key,
    title: item.label.slice(0, 24),
  }));

  return { bodyText, buttonLabel, sections: [{ title: sectionTitle, rows }] };
}
