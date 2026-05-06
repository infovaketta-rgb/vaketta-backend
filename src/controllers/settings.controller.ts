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
  connectWhatsAppEmbeddedSignup,
  getInstagramConfig,
  updateInstagramConfig,
  getIgSubscriptionStatus,
  subscribeIgWebhook,
  unsubscribeIgWebhook,
  getPlatformSettings,
  updatePlatformSettings,
} from "../services/settings.service";
import { invalidatePromptCache } from "../services/ai.service";

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
      allDay, aiInstructions,
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
      ...(allDay               !== undefined && { allDay }),
      ...(aiInstructions       !== undefined && { aiInstructions: aiInstructions || null }),
    });

    invalidatePromptCache(hotelId(req));
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
    invalidatePromptCache(hotelId(req));
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
    invalidatePromptCache(hotelId(req));
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
    invalidatePromptCache(hotelId(req));
    res.json({ success: true });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
}

export async function updateMenuTitleHandler(req: Request, res: Response) {
  try {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: "title is required" });
    const updated = await updateMenuTitle(hotelId(req), title);
    invalidatePromptCache(hotelId(req));
    res.json(updated);
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
    invalidatePromptCache(hotelId(req));
    res.json(hotel);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}

export async function embeddedSignupHandler(req: Request, res: Response) {
  try {
    const { code, wabaId, phoneNumberId, redirectUri } = req.body;
    if (!code || !wabaId || !phoneNumberId) {
      return res.status(400).json({ error: "code, wabaId, and phoneNumberId are required" });
    }
    const result = await connectWhatsAppEmbeddedSignup(hotelId(req), code, wabaId, phoneNumberId, redirectUri ?? "");
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
}

// ── Instagram ─────────────────────────────────────────────────────────────────

export async function getInstagramHandler(req: Request, res: Response) {
  try {
    res.json(await getInstagramConfig(hotelId(req)));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function patchInstagramHandler(req: Request, res: Response) {
  try {
    const { accessToken, igAccountId } = req.body;
    res.json(await updateInstagramConfig(hotelId(req), {
      ...(accessToken !== undefined && { accessToken }),
      ...(igAccountId !== undefined && { igAccountId }),
    }));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// ── Instagram webhook subscription ───────────────────────────────────────────

export async function getIgSubscriptionStatusHandler(req: Request, res: Response) {
  try {
    res.json(await getIgSubscriptionStatus(hotelId(req)));
  } catch (err: any) {
    const status = err.message === "Instagram not connected" ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
}

export async function subscribeIgWebhookHandler(req: Request, res: Response) {
  try {
    res.json(await subscribeIgWebhook(hotelId(req)));
  } catch (err: any) {
    const status = err.message === "Instagram not connected" ? 400 : 502;
    res.status(status).json({ error: err.message });
  }
}

export async function unsubscribeIgWebhookHandler(req: Request, res: Response) {
  try {
    res.json(await unsubscribeIgWebhook(hotelId(req)));
  } catch (err: any) {
    const status = err.message === "Instagram not connected" ? 400 : 502;
    res.status(status).json({ error: err.message });
  }
}

// ── Platform settings (Vaketta admin) ────────────────────────────────────────

export async function getPlatformSettingsHandler(_req: Request, res: Response) {
  try {
    res.json(await getPlatformSettings());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function patchPlatformSettingsHandler(req: Request, res: Response) {
  try {
    const { instagramEmbedUrl, whatsappEmbedSignupUrl } = req.body;
    res.json(await updatePlatformSettings({
      ...(instagramEmbedUrl       !== undefined && { instagramEmbedUrl:      String(instagramEmbedUrl).trim() }),
      ...(whatsappEmbedSignupUrl  !== undefined && { whatsappEmbedSignupUrl: String(whatsappEmbedSignupUrl).trim() }),
    }));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
