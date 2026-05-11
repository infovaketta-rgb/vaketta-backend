import prisma from "../db/connect";
import { decryptWhatsAppToken } from "../utils/encryption.utils";
import { TemplateCategory, TemplateStatus, MessageStatus, MessageChannel } from "@prisma/client";
import { emitToHotel } from "../realtime/emit";
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

// Pull the header format + persistent media handle out of Meta's raw components
// response. Stored as top-level columns so the send path can include the header
// without parsing the JSON components blob.
export function extractHeaderMeta(metaComponents: any[]): { headerFormat: string | null; headerHandle: string | null } {
  if (!Array.isArray(metaComponents)) return { headerFormat: null, headerHandle: null };
  const headerComp = metaComponents.find((c: any) => c?.type === "HEADER");
  if (!headerComp) return { headerFormat: null, headerHandle: null };
  return {
    headerFormat: headerComp.format ?? null,
    headerHandle: headerComp.example?.header_handle?.[0] ?? null,
  };
}

// ── Meta → internal component parser ─────────────────────────────────────────

export function parseMetaComponents(metaComponents: any[]): any {
  const result: any = { body: { text: "" } };

  for (const comp of metaComponents) {
    switch (comp.type) {
      case "HEADER":
        result.header = {
          format:    comp.format,
          text:      comp.text      ?? undefined,
          example:   comp.example?.header_text?.[0] ?? undefined,
          sampleUrl: comp.example?.header_handle?.[0] ?? undefined,
        };
        break;

      case "BODY": {
        const namedExamples: Record<string, string> = {};
        for (const e of comp.example?.body_text_named_params ?? []) {
          if (e?.param_name) namedExamples[e.param_name] = e.example ?? "";
        }
        result.body = {
          text:     comp.text ?? "",
          examples: comp.example?.body_text?.[0] ?? [],
          ...(Object.keys(namedExamples).length > 0 && { namedExamples }),
        };
        break;
      }

      case "FOOTER":
        result.footer = { text: comp.text ?? "" };
        break;

      case "BUTTONS":
        result.buttons = (comp.buttons ?? []).map((btn: any) => {
          if (btn.type === "QUICK_REPLY")  return { type: "QUICK_REPLY",  text: btn.text };
          if (btn.type === "PHONE_NUMBER") return { type: "PHONE_NUMBER", text: btn.text, phoneNumber: btn.phone_number };
          if (btn.type === "COPY_CODE")    return { type: "COPY_CODE",    text: btn.text, couponCode: btn.example?.[0] ?? "" };
          if (btn.type === "URL") {
            const b: any = { type: "URL", text: btn.text, url: btn.url };
            if (btn.example?.length) { b.isDynamic = true; b.urlExample = btn.example[0]; }
            return b;
          }
          if (btn.type === "OTP") return { type: "COPY_CODE", text: btn.text, couponCode: "" };
          return { type: btn.type, text: btn.text };
        });
        break;
    }
  }

  return result;
}

// ── Meta payload builder ──────────────────────────────────────────────────────

function buildMetaComponents(components: any): any[] {
  const result: any[] = [];
  const { header, body, footer, buttons } = components;

  if (header) {
    // parseMetaComponents stores "format"; the creation form stores "type" — accept both
    const format = header.format ?? header.type;
    const h: any = { type: "HEADER", format };
    if (format === "TEXT") {
      h.text = header.text ?? "";
      if (header.example) h.example = { header_text: [header.example] };
    } else if (["IMAGE", "VIDEO", "DOCUMENT"].includes(format)) {
      // sampleUrl comes from Meta-synced data; mediaUrl from the upload form.
      // header_handle must be a Meta upload handle (opaque ID), NOT a CDN/https URL.
      // If we only have a CDN URL, omit the example — Meta will request samples during review.
      const sampleUrl = header.sampleUrl ?? header.mediaUrl;
      if (sampleUrl && !sampleUrl.startsWith("http")) {
        h.example = { header_handle: [sampleUrl] };
      }
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
        // couponCode: stored by parseMetaComponents (sync from Meta); example: stored by the creation form
        if (btn.type === "COPY_CODE")     return { type: "COPY_CODE", example: [btn.couponCode ?? btn.example ?? ""] };
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

  const metaPayload = buildMetaPayload(data);
  log.info({ metaPayload }, "submitting template to Meta API");
  console.log("[templates] Meta submission payload:", JSON.stringify(metaPayload, null, 2));

  const metaRes = await fetch(
    `https://graph.facebook.com/v23.0/${wabaId}/message_templates`,
    {
      method:  "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body:    JSON.stringify(metaPayload),
    }
  );
  const metaData = await metaRes.json() as any;
  if (!metaRes.ok) {
    log.warn({ metaError: metaData?.error }, "Meta template creation failed");
    console.error("[templates] Meta API error response:", JSON.stringify(metaData, null, 2));
    const err = Object.assign(
      new Error(metaData?.error?.error_user_msg ?? metaData?.error?.message ?? "Meta API error"),
      { status: 400, details: metaData?.error }
    );
    throw err;
  }

  // Persist the header format up-front so the send path knows the shape. The
  // persistent header_handle isn't known until Meta returns it on a subsequent
  // GET (after approval), so headerHandle is filled in by syncTemplate.
  const headerFormat = data.components?.header?.format ?? data.components?.header?.type ?? null;

  return prisma.whatsAppTemplate.create({
    data: {
      hotelId,
      name:               data.name,
      language:           data.language,
      category:           data.category,
      status:             "PENDING",
      metaTemplateId:     String(metaData.id),
      components:         data.components,
      headerFormat,
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
    `https://graph.facebook.com/v23.0/${existing.metaTemplateId}?fields=status,quality_score,rejected_reason,components`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await metaRes.json() as any;

  // DIAGNOSTIC: dump everything Meta sent back so we can see whether
  // example.header_handle[0] is present, absent, or under a different path.
  console.log("[sync-debug] templateName:", existing.name);
  console.log("[sync-debug] metaTemplateId:", existing.metaTemplateId);
  console.log("[sync-debug] HTTP status:", metaRes.status);
  console.log("[sync-debug] raw Meta GET response:", JSON.stringify(data, null, 2));
  console.log("[sync-debug] components (raw):", JSON.stringify(data?.components, null, 2));
  const headerComp = Array.isArray(data?.components)
    ? data.components.find((c: any) => c?.type === "HEADER")
    : null;
  console.log("[sync-debug] HEADER component:", JSON.stringify(headerComp, null, 2));
  console.log("[sync-debug] headerComp.format:", headerComp?.format);
  console.log("[sync-debug] headerComp.example:", JSON.stringify(headerComp?.example, null, 2));
  console.log("[sync-debug] header_handle[0]:", headerComp?.example?.header_handle?.[0]);

  const updateData: any = {
    status:          (data.status ?? existing.status) as TemplateStatus,
    qualityScore:    data.quality_score?.score ?? existing.qualityScore ?? null,
    rejectionReason: data.rejected_reason ?? null,
  };

  if (Array.isArray(data.components) && data.components.length > 0) {
    updateData.components = parseMetaComponents(data.components);
    const { headerFormat, headerHandle } = extractHeaderMeta(data.components);
    updateData.headerFormat = headerFormat;
    updateData.headerHandle = headerHandle;
  }

  console.log("[sync-debug] Prisma update payload:", JSON.stringify(updateData, null, 2));

  return prisma.whatsAppTemplate.update({
    where: { id: templateId },
    data:  updateData,
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

  const [{ phoneNumberId, accessToken }, hotel] = await Promise.all([
    getWaCredentials(hotelId),
    prisma.hotel.findUnique({ where: { id: hotelId }, select: { phone: true } }),
  ]);

  const components = template.components as any;
  const sendComponents: any[] = [];

  function extractVarIds(text: string): string[] {
    const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
    const seen = new Set<string>();
    const ids: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const id = m[1]!;
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
    return ids;
  }

  function buildTextParams(ids: string[], lookup: (id: string) => string) {
    return ids.map((id) => {
      const isNamed = !/^\d+$/.test(id);
      return isNamed
        ? { type: "text", parameter_name: id, text: lookup(id) }
        : { type: "text", text: lookup(id) };
    });
  }

  // Header — supports TEXT (with text variables) and IMAGE/VIDEO/DOCUMENT.
  // Format comes from the top-level column (populated on sync); fall back to the
  // components JSON for templates that pre-date the migration.
  const header = components.header ?? {};
  const headerFormat = template.headerFormat ?? header.format ?? header.type;

  if (headerFormat === "TEXT" && header.text) {
    const headerIds = extractVarIds(header.text);
    if (headerIds.length > 0) {
      sendComponents.push({
        type: "header",
        parameters: buildTextParams(headerIds, (id) =>
          values[id] ?? values[`header_${id}`] ?? values["header_1"] ?? ""
        ),
      });
    }
  } else if (headerFormat === "IMAGE" || headerFormat === "VIDEO" || headerFormat === "DOCUMENT") {
    // Resolve the media reference. Priority:
    //   1. Send-time override URL from values[] → `link` (dynamic per-booking imagery)
    //   2. Numeric media id stored in template.headerHandle → `id` (from POST /{phoneNumberId}/media)
    //   3. Vaketta-stored mediaUrl on our own CDN → `link`
    //
    // For static templates approved with a sample image, Meta's GET response returns
    // a scontent.whatsapp.net CDN URL in example.header_handle[0]. That value is NOT
    // a numeric media id — passing it as `image.id` is rejected by Meta with a JSON
    // schema error (expected: [integer, null]). It is also not reliable as `link`
    // since the URL expires. The correct behaviour is to omit the header component
    // entirely; Meta then renders the approved sample image automatically.
    const mediaKey = headerFormat.toLowerCase(); // "image" | "video" | "document"
    const provided = values["header_image"] ?? values["header_video"] ?? values["header_document"] ?? values["header_media"];

    let mediaParam: any = null;
    if (provided && provided.startsWith("http")) {
      mediaParam = { type: mediaKey, [mediaKey]: { link: provided } };
    } else if (template.headerHandle && /^\d+$/.test(template.headerHandle)) {
      // Numeric handle → reusable Meta media id from the /media upload endpoint
      mediaParam = { type: mediaKey, [mediaKey]: { id: template.headerHandle } };
    } else if (header.mediaUrl && header.mediaUrl.startsWith("http")) {
      mediaParam = { type: mediaKey, [mediaKey]: { link: header.mediaUrl } };
    }
    // else: scontent CDN URL or unrecognised value — omit header, let Meta render the sample

    if (mediaParam) {
      sendComponents.push({ type: "header", parameters: [mediaParam] });
    }
  }

  // Body variables — supports both positional ({{1}}) and named ({{guestname}}) formats.
  const bodyText   = components.body?.text ?? "";
  const bodyVarIds = extractVarIds(bodyText);
  if (bodyVarIds.length > 0) {
    sendComponents.push({
      type: "body",
      parameters: buildTextParams(bodyVarIds, (id) => values[id] ?? ""),
    });
  }

  (components.buttons ?? []).forEach((btn: any, i: number) => {
    if (btn.type === "URL" && btn.isDynamic) {
      const v = values[`btn_${i}`] ?? "";
      if (v) sendComponents.push({ type: "button", sub_type: "url", index: i, parameters: [{ type: "text", text: v }] });
    }
    if (btn.type === "COPY_CODE") {
      // Only include the button component if a coupon value is provided at send-time.
      // If the template has a static couponCode baked in, omit the parameter entirely.
      const v = values[`btn_${i}`];
      if (v) sendComponents.push({ type: "button", sub_type: "copy_code", index: i, parameters: [{ type: "coupon_code", coupon_code: v }] });
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

  log.info({ templateName: template.name, payload }, "[templates] sending template message to Meta");

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
    log.warn({ templateName: template.name, payload, metaError: metaData?.error }, "[templates] Meta rejected template send");
    throw Object.assign(
      new Error(metaData?.error?.message ?? "Failed to send template message"),
      { status: 502 }
    );
  }

  const wamid      = metaData?.messages?.[0]?.id ?? null;
  const fromPhone  = hotel?.phone ?? "";

  // Render the body text so the bubble shows the actual message content
  const renderedBody = (components.body?.text ?? template.name).replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_: string, id: string) => values[id] ?? `{{${id}}}`
  );

  // Persist so the chat thread shows the outbound bubble immediately
  const savedMessage = await prisma.message.create({
    data: {
      direction:   "OUT",
      fromPhone,
      toPhone:     guest.phone,
      body:        renderedBody,
      messageType: "text",
      hotelId,
      guestId,
      channel:     MessageChannel.WHATSAPP,
      status:      MessageStatus.SENT,
      ...(wamid ? { wamid } : {}),
    },
  });

  emitToHotel(hotelId, "message:new", { message: savedMessage });

  return { success: true, messageId: wamid };
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
        `https://graph.facebook.com/v23.0/${t.metaTemplateId}?fields=status,quality_score,rejected_reason,components`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const data = await res.json() as any;
      if (res.ok && data.status) {
        const update: any = {
          status:          data.status,
          qualityScore:    data.quality_score?.score ?? null,
          rejectionReason: data.rejected_reason ?? null,
        };
        if (Array.isArray(data.components) && data.components.length > 0) {
          update.components = parseMetaComponents(data.components);
          const { headerFormat, headerHandle } = extractHeaderMeta(data.components);
          update.headerFormat = headerFormat;
          update.headerHandle = headerHandle;
        }
        await prisma.whatsAppTemplate.update({ where: { id: t.id }, data: update });
      }
    } catch (err) {
      log.warn({ err, templateId: t.id }, "cron sync failed for template");
    }
  }
  log.info({ count: pending.length }, "template cron sync complete");
}
