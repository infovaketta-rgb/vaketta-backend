import { Request, Response } from "express";
import {
  getHotelSettings,
  updateHotelConfig,
  updateHotelProfile,
  updateBotMessages,
  getMenu,
  addMenuItem,
  updateMenuItem,
  deleteMenuItem,
  updateMenuTitle,
  getWhatsAppConfig,
  updateWhatsAppConfig,
  testWhatsAppConnection,
} from "../services/settings.service";

function hotelId(req: Request): string {
  return (req as any).user.hotelId;
}

export async function getSettings(req: Request, res: Response) {
  try {
    const data = await getHotelSettings(hotelId(req));
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function patchSettings(req: Request, res: Response) {
  try {
    const {
      autoReplyEnabled, bookingEnabled, bookingFlowId, menuFlowId, aiEnabled,
      businessStartHour, businessEndHour,
      timezone, defaultLanguage,
      welcomeMessage, nightMessage,
      messageDelayEnabled, messageDelaySeconds,
    } = req.body;

    const config = await updateHotelConfig(hotelId(req), {
      ...(autoReplyEnabled     !== undefined && { autoReplyEnabled }),
      ...(bookingEnabled       !== undefined && { bookingEnabled }),
      ...(bookingFlowId        !== undefined && { bookingFlowId: bookingFlowId || null }),
      ...(menuFlowId           !== undefined && { menuFlowId:    menuFlowId    || null }),
      ...(aiEnabled            !== undefined && { aiEnabled }),
      ...(businessStartHour    !== undefined && { businessStartHour: Number(businessStartHour) }),
      ...(businessEndHour      !== undefined && { businessEndHour:   Number(businessEndHour) }),
      ...(timezone             !== undefined && { timezone }),
      ...(defaultLanguage      !== undefined && { defaultLanguage }),
      ...(welcomeMessage       !== undefined && { welcomeMessage }),
      ...(nightMessage         !== undefined && { nightMessage }),
      ...(messageDelayEnabled  !== undefined && { messageDelayEnabled }),
      ...(messageDelaySeconds  !== undefined && { messageDelaySeconds: Number(messageDelaySeconds) }),
    });

    res.json(config);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function getMenuHandler(req: Request, res: Response) {
  try {
    res.json(await getMenu(hotelId(req)));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function addMenuItemHandler(req: Request, res: Response) {
  try {
    const { key, label, replyText, order, type, flowId } = req.body;
    if (!key || !label) {
      return res.status(400).json({ error: "key and label are required" });
    }
    const item = await addMenuItem(hotelId(req), {
      key, label, replyText: replyText ?? "", order: Number(order ?? 0), type: type ?? "INFO",
      flowId: flowId ?? null,
    });
    res.status(201).json(item);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function updateMenuItemHandler(req: Request, res: Response) {
  try {
    const itemId = req.params["itemId"];
    if (!itemId) return res.status(400).json({ error: "itemId required" });
    const item = await updateMenuItem(itemId, hotelId(req), req.body);
    res.json(item);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
}

export async function deleteMenuItemHandler(req: Request, res: Response) {
  try {
    const itemId = req.params["itemId"];
    if (!itemId) return res.status(400).json({ error: "itemId required" });
    await deleteMenuItem(itemId, hotelId(req));
    res.json({ success: true });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
}

export async function updateMenuTitleHandler(req: Request, res: Response) {
  try {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: "title is required" });
    res.json(await updateMenuTitle(hotelId(req), title));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function patchBotMessages(req: Request, res: Response) {
  try {
    const messages = req.body as Record<string, string>;
    const config = await updateBotMessages(hotelId(req), messages);
    res.json(config);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function testWhatsAppHandler(req: Request, res: Response) {
  try {
    const result = await testWhatsAppConnection(hotelId(req));
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err: any) {
    res.status(500).json({ ok: false, detail: err.message });
  }
}

export async function getWhatsAppHandler(req: Request, res: Response) {
  try {
    res.json(await getWhatsAppConfig(hotelId(req)));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function patchWhatsAppHandler(req: Request, res: Response) {
  try {
    const { metaPhoneNumberId, metaAccessToken, metaWabaId, metaVerifyToken } = req.body;
    await updateWhatsAppConfig(hotelId(req), {
      ...(metaPhoneNumberId !== undefined && { metaPhoneNumberId }),
      ...(metaAccessToken   !== undefined && { metaAccessToken }),
      ...(metaWabaId        !== undefined && { metaWabaId }),
      ...(metaVerifyToken   !== undefined && { metaVerifyToken }),
    });
    // Return fresh (masked) data so UI updates
    res.json(await getWhatsAppConfig(hotelId(req)));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function patchHotelProfile(req: Request, res: Response) {
  try {
    const { name, location, email, description, checkInTime, checkOutTime, website } = req.body;
    const hotel = await updateHotelProfile(hotelId(req), {
      ...(name         !== undefined && { name }),
      ...(location     !== undefined && { location }),
      ...(email        !== undefined && { email }),
      ...(description  !== undefined && { description }),
      ...(checkInTime  !== undefined && { checkInTime }),
      ...(checkOutTime !== undefined && { checkOutTime }),
      ...(website      !== undefined && { website }),
    });
    res.json(hotel);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}
