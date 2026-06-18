/**
 * Tests for templateVariableMapping.controller.ts — CRUD with replace-on-save,
 * validation, and cross-hotel rejection (mirrors the Confirmation Sequence pattern).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const txClient = {
  templateVariableMapping: { deleteMany: vi.fn(), createMany: vi.fn() },
};

vi.mock("../db/connect", () => ({
  default: {
    whatsAppTemplate:        { findFirst: vi.fn() },
    templateVariableMapping: { findMany: vi.fn() },
    flowDefinition:          { findMany: vi.fn() },
    $transaction: vi.fn(async (cb: any) => cb(txClient)),
  },
}));
vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));

import prisma from "../db/connect";
import {
  listTemplateVariableMappings,
  replaceTemplateVariableMappings,
  listHotelFlowVarNames,
} from "./templateVariableMapping.controller";

const p = prisma as any;

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; });
  res.json   = vi.fn((b: any) => { res.body = b; return res; });
  return res;
}
function req(over: any = {}) {
  return { user: { hotelId: "h1", role: "ADMIN" }, params: {}, body: {}, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  p.whatsAppTemplate.findFirst.mockResolvedValue({ id: "tmpl1" });   // owned by default
  p.templateVariableMapping.findMany.mockResolvedValue([]);
  txClient.templateVariableMapping.deleteMany.mockResolvedValue({ count: 0 });
  txClient.templateVariableMapping.createMany.mockResolvedValue({ count: 0 });
});

// ── LIST ─────────────────────────────────────────────────────────────────────────

describe("listTemplateVariableMappings", () => {
  it("404s for another hotel's template", async () => {
    p.whatsAppTemplate.findFirst.mockResolvedValue(null);
    const res = mockRes();
    await listTemplateVariableMappings(req({ params: { templateId: "t-other" } }) as any, res);
    expect(res.statusCode).toBe(404);
    expect(p.whatsAppTemplate.findFirst.mock.calls[0]![0].where).toMatchObject({ id: "t-other", hotelId: "h1" });
  });

  it("returns the saved mappings for the template", async () => {
    p.templateVariableMapping.findMany.mockResolvedValue([
      { variableName: "guestname", sourceType: "BOOKING_FIELD", sourceKey: "guestName" },
      { variableName: "arrival",   sourceType: "FLOW_VAR",      sourceKey: "arrivalTime" },
    ]);
    const res = mockRes();
    await listTemplateVariableMappings(req({ params: { templateId: "tmpl1" } }) as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.mappings).toHaveLength(2);
  });
});

// ── REPLACE (create / replace-on-save) ───────────────────────────────────────────

describe("replaceTemplateVariableMappings", () => {
  it("404s for another hotel's template (cross-hotel rejection)", async () => {
    p.whatsAppTemplate.findFirst.mockResolvedValue(null);
    const res = mockRes();
    await replaceTemplateVariableMappings(req({
      params: { templateId: "t-other" },
      body: { mappings: [{ variableName: "x", sourceType: "BOOKING_FIELD", sourceKey: "guestName" }] },
    }) as any, res);
    expect(res.statusCode).toBe(404);
    expect(txClient.templateVariableMapping.createMany).not.toHaveBeenCalled();
  });

  it("replaces existing rows (deleteMany then createMany) in a transaction", async () => {
    const res = mockRes();
    await replaceTemplateVariableMappings(req({
      params: { templateId: "tmpl1" },
      body: { mappings: [
        { variableName: "guestname", sourceType: "BOOKING_FIELD", sourceKey: "guestName" },
        { variableName: "arrival",   sourceType: "FLOW_VAR",      sourceKey: "arrivalTime" },
      ] },
    }) as any, res);

    expect(res.statusCode).toBe(200);
    expect(txClient.templateVariableMapping.deleteMany).toHaveBeenCalledWith({ where: { hotelId: "h1", templateId: "tmpl1" } });
    const created = txClient.templateVariableMapping.createMany.mock.calls[0]![0].data;
    expect(created).toEqual([
      { hotelId: "h1", templateId: "tmpl1", variableName: "guestname", sourceType: "BOOKING_FIELD", sourceKey: "guestName" },
      { hotelId: "h1", templateId: "tmpl1", variableName: "arrival",   sourceType: "FLOW_VAR",      sourceKey: "arrivalTime" },
    ]);
  });

  it("drops rows with a blank sourceKey (unmapped → manual input)", async () => {
    const res = mockRes();
    await replaceTemplateVariableMappings(req({
      params: { templateId: "tmpl1" },
      body: { mappings: [
        { variableName: "guestname", sourceType: "BOOKING_FIELD", sourceKey: "guestName" },
        { variableName: "blank",     sourceType: "BOOKING_FIELD", sourceKey: "" },  // dropped
      ] },
    }) as any, res);

    expect(res.statusCode).toBe(200);
    const created = txClient.templateVariableMapping.createMany.mock.calls[0]![0].data;
    expect(created).toHaveLength(1);
    expect(created[0].variableName).toBe("guestname");
  });

  it("clears all mappings when given an empty array (deleteMany, no createMany)", async () => {
    const res = mockRes();
    await replaceTemplateVariableMappings(req({ params: { templateId: "tmpl1" }, body: { mappings: [] } }) as any, res);
    expect(res.statusCode).toBe(200);
    expect(txClient.templateVariableMapping.deleteMany).toHaveBeenCalled();
    expect(txClient.templateVariableMapping.createMany).not.toHaveBeenCalled();
  });

  it("400s on an invalid sourceType", async () => {
    const res = mockRes();
    await replaceTemplateVariableMappings(req({
      params: { templateId: "tmpl1" },
      body: { mappings: [{ variableName: "x", sourceType: "BOGUS", sourceKey: "y" }] },
    }) as any, res);
    expect(res.statusCode).toBe(400);
    expect(txClient.templateVariableMapping.createMany).not.toHaveBeenCalled();
  });

  it("400s on a duplicate variable name", async () => {
    const res = mockRes();
    await replaceTemplateVariableMappings(req({
      params: { templateId: "tmpl1" },
      body: { mappings: [
        { variableName: "dup", sourceType: "BOOKING_FIELD", sourceKey: "guestName" },
        { variableName: "dup", sourceType: "FLOW_VAR",      sourceKey: "arrivalTime" },
      ] },
    }) as any, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/duplicate/i);
  });

  it("400s when mappings is not an array", async () => {
    const res = mockRes();
    await replaceTemplateVariableMappings(req({ params: { templateId: "tmpl1" }, body: {} }) as any, res);
    expect(res.statusCode).toBe(400);
  });
});

// ── flow-var-names ───────────────────────────────────────────────────────────────

describe("listHotelFlowVarNames", () => {
  it("returns the hotel's flow var names", async () => {
    p.flowDefinition.findMany.mockResolvedValue([
      { nodes: [{ type: "question", data: { variableName: "arrivalTime" } }] },
    ]);
    const res = mockRes();
    await listHotelFlowVarNames(req() as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.names).toContain("arrivalTime");
    expect(res.body.names).toContain("guestName"); // system var
  });
});
