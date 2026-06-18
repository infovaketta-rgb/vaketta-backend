import prisma from "../db/connect";

// ── Template Variable Mapping ────────────────────────────────────────────────────
// Maps a template's {{var}} placeholders to a booking field (BOOKING_FIELD) or a
// flow-builder variable (FLOW_VAR). FLOW_VAR mappings drive which session flowVars
// get snapshotted onto Booking.flowVars at create_booking time (see flowRuntime).

export type MappingSourceType = "BOOKING_FIELD" | "FLOW_VAR";

export interface TemplateVariableMappingRow {
  variableName: string;
  sourceType:   MappingSourceType;
  sourceKey:    string;
}

/**
 * Distinct flow-variable names this hotel watches — i.e. every sourceKey of a
 * FLOW_VAR mapping across all of the hotel's templates. create_booking persists
 * exactly these (and no other) session flowVars onto the Booking row.
 */
export async function getWatchedFlowVarNames(hotelId: string): Promise<string[]> {
  const rows = await prisma.templateVariableMapping.findMany({
    where:    { hotelId, sourceType: "FLOW_VAR" },
    select:   { sourceKey: true },
    distinct: ["sourceKey"],
    orderBy:  { sourceKey: "asc" },
  });
  return rows.map((r) => r.sourceKey);
}

/**
 * Pick only the watched names out of a flowVars map, returning a plain object.
 * Pure + dependency-free so it can be unit-tested without the flowRuntime chain.
 * Returns null when nothing matches (so the Booking.flowVars column stays null
 * rather than storing an empty object).
 */
export function pickWatchedFlowVars(
  flowVars: Record<string, string>,
  watchedNames: string[]
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const name of watchedNames) {
    const v = flowVars[name];
    if (v !== undefined) out[name] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** All mappings for a given template (hotel-scoped), ordered by variable name. */
export async function getTemplateMappings(
  hotelId:    string,
  templateId: string
): Promise<TemplateVariableMappingRow[]> {
  const rows = await prisma.templateVariableMapping.findMany({
    where:   { hotelId, templateId },
    orderBy: { variableName: "asc" },
    select:  { variableName: true, sourceType: true, sourceKey: true },
  });
  return rows.map((r) => ({
    variableName: r.variableName,
    sourceType:   r.sourceType as MappingSourceType,
    sourceKey:    r.sourceKey,
  }));
}

// System variable names always available in every flow (mirrors the frontend
// SYSTEM_VARS / runtime injection in flowRuntime). Kept here so the picker can
// offer them even when a hotel hasn't authored a question node yet.
const SYSTEM_FLOW_VAR_NAMES = [
  "hotelName", "guestName", "guestPhone", "currentDate", "currentTime", "currentDay",
];

// Node-data keys that hold a flow-variable NAME a node writes to. Parsed from the
// hotel's flow definitions so the picker reflects variables actually collected.
const VAR_NAME_KEYS = ["variableName", "variableToSet"];

/**
 * Distinct flow-variable names a hotel's flows can produce: the system vars plus
 * every `variableName` / `variableToSet` declared on any node of any of the
 * hotel's flow definitions. Pure-ish: only reads FlowDefinition rows. This is the
 * pragmatic substitute for the Flow Builder's graph-bound variable picker, which
 * is not reusable outside the canvas (it needs a specific flow's nodes+edges+target).
 */
export async function getHotelFlowVarNames(hotelId: string): Promise<string[]> {
  const flows = await prisma.flowDefinition.findMany({
    where:  { hotelId },
    select: { nodes: true },
  });

  const names = new Set<string>(SYSTEM_FLOW_VAR_NAMES);
  for (const flow of flows) {
    const nodes = Array.isArray(flow.nodes) ? (flow.nodes as any[]) : [];
    for (const node of nodes) {
      const data = node?.data ?? {};
      for (const key of VAR_NAME_KEYS) {
        const v = data[key];
        if (typeof v === "string" && v.trim()) names.add(v.trim());
      }
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}
