import prisma from "../db/connect";
import { decryptWhatsAppToken } from "../utils/encryption.utils";
import { TemplateCategory, TemplateStatus } from "@prisma/client";
import { logger } from "../utils/logger";

const log = logger.child({ service: "templates" });

// ── Credentials helper ────────────────────────────────────────────────────────

async function getWaCredentials(hotelId: string) {
  const config = await prisma.hotelConfig.findUnique({ where: { hotelId } });
  if (!config?.metaWabaId || !config?.metaAccessTokenEncrypted || !config?.metaPhoneNumberId) {
    throw Object.assign(new Error("WhatsApp is not configured for this hotel"), { status: 400 });
  }
  const accessToken = decryptWhatsAppToken(config.metaAccessTokenEncrypted);
  return { wabaId: config.metaWabaId, accessToken, phoneNumberId: config.metaPhoneNumberId };
}

// ── Meta payload builder ──────────────────────────────────────────────────────

function buildMetaComponents(components: any): any[] {
  const result: any[] = [];
  const { header, body, footer, buttons } = components;

  if (header) {
    const h: any = { type: "HEADER", format: header.format };
    if (header.format === "TEXT") {
      h.text = header.text ?? "";
      if (header.example) h.example = { header_text: [header.example] };
    } else if (["IMAGE", "VIDEO", "DOCUMENT"].includes(header.format)) {
      if (header.sampleUrl) h.example = { header_handle: [header.sampleUrl] };
    }
    result.push(h);
  }

  const bodyComp: any = { type: "BODY", text: body.text };
  if (body.examples?.length) {
    bodyComp.example = { body_text: [body.examples] };
  }
  result.push(bodyComp);

  if (footer) {
    result.push({ type: "FOOTER", text: footer.text });
  }

  if (buttons?.length) {
    result.push({
      type: "BUTTONS",
      buttons: buttons.map((btn: any) => {
        if (btn.type === "QUICK_REPLY")   return { type: "QUICK_REPLY", text: btn.text };
        if (btn.type === "PHONE_NUMBER")  return { type: "PHONE_NUMBER", text: btn.text, phone_number: btn.phoneNumber };
        if (btn.type === "COPY_CODE")     return { type: "COPY_CODE", example: [btn.couponCode ?? ""] };
        if (btn.type === "URL") {
          const b: any = { type: "URL", text: btn.text, url: btn.url };
          if (btn.isDynamic && btn.urlExample) b.example = [btn.urlExample];
          return b;
        }
        return btn;
      }),
    });
  }
  return result;
}

function buildMetaPayload(data: any) {
  return {
    name:                    data.name,
    language:                data.language,
    category:                data.category,
    allow_category_change:   data.allowCategoryChange ?? true,
    ...(data.ttlSeconds && { message_send_ttl_seconds: data.ttlSeconds }),
    components:              buildMetaComponents(data.components),
  };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function getTemplates(
  hotelId: string,
  filters: { category?: string; status?: string; search?: string }
) {
  const { category, status, search } = filters;
  return prisma.whatsAppTemplate.findMany({
    where: {
      hotelId,
      ...(category && { category: category as TemplateCategory }),
      ...(status   && { status:   status   as TemplateStatus }),
      ...(search   && { name: { contains: search, mode: "insensitive" as const } }),
    },
    orderBy: { updatedAt: "desc" },
  });
}

export async function createTemplate(hotelId: string, data: any) {
  const { wabaId, accessToken } = await getWaCredentials(hotelId);

  const metaRes = await fetch(
    `https://graph.facebook.com/v23.0/${wabaId}/message_templates`,
    {
      method:  "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body:    JSON.stringify(buildMetaPayload(data)),
    }
  );
  const metaData = await metaRes.json() as any;
  if (!metaRes.ok) {
    const err = Object.assign(
      new Error(metaData?.error?.message ?? "Meta API error"),
      { status: 400, details: metaData?.error }
    );
    throw err;
  }

  return prisma.whatsAppTemplate.create({
    data: {
      hotelId,
      name:               data.name,
      language:           data.language,
      category:           data.category,
      status:             "PENDING",
      metaTemplateId:     String(metaData.id),
      components:         data.components,
      allowCategoryChange: data.allowCategoryChange ?? true,
      ttlSeconds:         data.ttlSeconds ?? null,
    },
  });
}

export async function updateTemplate(hotelId: string, templateId: string, data: any) {
  const existing = await prisma.whatsAppTemplate.findFirst({ where: { id: templateId, hotelId } });
  if (!existing) throw Object.assign(new Error("Template not found"), { status: 404 });

  if (existing.status === "DISABLED") {
    throw Object.assign(
      new Error("Disabled templates cannot be edited. Delete and recreate."),
      { status: 400 }
    );
  }

  if (existing.status === "APPROVED") {
    const oneDayAgo      = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const thirtyDaysAgo  = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    if (existing.lastEditedAt && existing.lastEditedAt > oneDayAgo) {
      throw Object.assign(
        new Error("Approved templates can only be edited once per 24 hours."),
        { status: 429 }
      );
    }
    if (existing.editCount >= 10 && existing.lastEditedAt && existing.lastEditedAt > thirtyDaysAgo) {
      throw Object.assign(
        new Error("Approved templates can only be edited 10 times per 30 days."),
        { status: 429 }
      );
    }
  }

  const { accessToken } = await getWaCredentials(hotelId);

  if (existing.metaTemplateId) {
    const metaRes = await fetch(
      `https://graph.facebook.com/v23.0/${existing.metaTemplateId}`,
      {
        method:  "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ components: buildMetaComponents(data.components) }),
      }
    );
    if (!metaRes.ok) {
      const metaData = await metaRes.json() as any;
      log.warn({ metaData }, "Meta template update returned non-ok");
    }
  }

  return prisma.whatsAppTemplate.update({
    where: { id: templateId },
    data: {
      components:  data.components,
      status:      "PENDING",
      editCount:   { increment: 1 },
      lastEditedAt: new Date(),
    },
  });
}

export async function deleteTemplate(hotelId: string, templateId: string) {
  const existing = await prisma.whatsAppTemplate.findFirst({ where: { id: templateId, hotelId } });
  if (!existing) throw Object.assign(new Error("Template not found"), { status: 404 });

  const { wabaId, accessToken } = await getWaCredentials(hotelId);

  await fetch(
    `https://graph.facebook.com/v23.0/${wabaId}/message_templates?name=${encodeURIComponent(existing.name)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } }
  );

  await prisma.whatsAppTemplate.delete({ where: { id: templateId } });
  return { success: true };
}

export async function syncTemplate(hotelId: string, templateId: string) {
  const existing = await prisma.whatsAppTemplate.findFirst({ where: { id: templateId, hotelId } });
  if (!existing) throw Object.assign(new Error("Template not found"), { status: 404 });
  if (!existing.metaTemplateId) throw Object.assign(new Error("Template has no Meta ID yet"), { status: 400 });

  const { accessToken } = await getWaCredentials(hotelId);

  const metaRes = await fetch(
    `https://graph.facebook.com/v23.0/${existing.metaTemplateId}?fields=status,quality_score,rejected_reason`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await metaRes.json() as any;

  return prisma.whatsAppTemplate.update({
    where: { id: templateId },
    data: {
      status:         (data.status          ?? existing.status)       as TemplateStatus,
      qualityScore:   data.quality_score?.score ?? existing.qualityScore ?? null,
      rejectionReason: data.rejected_reason  ?? null,
    },
  });
}

// ── Send via WhatsApp Cloud API ───────────────────────────────────────────────

export async function sendTemplateMessage(
  hotelId:    string,
  guestId:    string,
  templateId: string,
  values:     Record<string, string>
) {
  const [template, guest] = await Promise.all([
    prisma.whatsAppTemplate.findFirst({ where: { id: templateId, hotelId } }),
    prisma.guest.findFirst({ where: { id: guestId, hotelId } }),
  ]);

  if (!template) throw Object.assign(new Error("Template not found"), { status: 404 });
  if (template.status !== "APPROVED") {
    throw Object.assign(new Error("Only APPROVED templates can be sent"), { status: 400 });
  }
  if (!guest) throw Object.assign(new Error("Guest not found"), { status: 404 });

  const { phoneNumberId, accessToken } = await getWaCredentials(hotelId);
  const components = template.components as any;
  const sendComponents: any[] = [];

  if (components.header?.format === "TEXT" && components.header.text?.includes("{{")) {
    sendComponents.push({ type: "header", parameters: [{ type: "text", text: values["header_1"] ?? "" }] });
  }
  if (components.body?.text?.includes("{{")) {
    const params = (components.body.examples ?? []).map((_: any, i: number) => ({
      type: "text", text: values[`body_${i + 1}`] ?? "",
    }));
    if (params.length) sendComponents.push({ type: "body", parameters: params });
  }
  (components.buttons ?? []).forEach((btn: any, i: number) => {
    if (btn.type === "URL" && btn.isDynamic) {
      sendComponents.push({ type: "button", sub_type: "url", index: i, parameters: [{ type: "text", text: values[`btn_${i}`] ?? "" }] });
    }
    if (btn.type === "COPY_CODE") {
      sendComponents.push({ type: "button", sub_type: "COPY_CODE", index: i, parameters: [{ type: "coupon_code", coupon_code: values[`btn_${i}`] ?? "" }] });
    }
  });

  const payload = {
    messaging_product: "whatsapp",
    to:   guest.phone,
    type: "template",
    template: {
      name:       template.name,
      language:   { code: template.language },
      components: sendComponents,
    },
  };

  const metaRes = await fetch(
    `https://graph.facebook.com/v23.0/${phoneNumberId}/messages`,
    {
      method:  "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    }
  );
  const metaData = await metaRes.json() as any;
  if (!metaRes.ok) {
    throw Object.assign(
      new Error(metaData?.error?.message ?? "Failed to send template message"),
      { status: 502 }
    );
  }

  return { success: true, messageId: metaData?.messages?.[0]?.id ?? null };
}

// ── Background sync (called from cron) ───────────────────────────────────────

export async function syncPendingTemplates() {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000); // older than 30 min
  const pending = await prisma.whatsAppTemplate.findMany({
    where: { status: "PENDING", createdAt: { lt: cutoff } },
    include: { hotel: { include: { config: true } } },
  });

  for (const t of pending) {
    try {
      if (!t.metaTemplateId || !t.hotel.config?.metaAccessTokenEncrypted) continue;
      const accessToken = decryptWhatsAppToken(t.hotel.config.metaAccessTokenEncrypted);
      const res = await fetch(
        `https://graph.facebook.com/v23.0/${t.metaTemplateId}?fields=status,quality_score,rejected_reason`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const data = await res.json() as any;
      if (res.ok && data.status) {
        await prisma.whatsAppTemplate.update({
          where: { id: t.id },
          data:  { status: data.status, qualityScore: data.quality_score?.score ?? null, rejectionReason: data.rejected_reason ?? null },
        });
      }
    } catch (err) {
      log.warn({ err, templateId: t.id }, "cron sync failed for template");
    }
  }
  log.info({ count: pending.length }, "template cron sync complete");
}
