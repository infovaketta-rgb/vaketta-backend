/**
 * advancedRoomAllocation.ts — COMPATIBILITY BARREL. Do not add code here.
 *
 * The implementation lives in ./ara/*, split by concern (types, allocator,
 * plans, appliers, ages, render, keywords, state, phases, handler). This file
 * exists only so every existing import path keeps resolving — flowRuntime.ts,
 * planList.ts, modifyLists.ts and the test suite all import from here.
 *
 * Architecture notes that still govern ./ara:
 *   • Fully stateless outside flowData.flowVars["__araState__"]. Vaketta deploys
 *     to multiple processes; ANY module-level state would corrupt allocations
 *     when requests are load-balanced across instances.
 *   • Imports NOTHING from flowRuntime.ts (would cause a circular import). All
 *     runtime dependencies — fetchRoomTypes, getCalendarData, safeMenu,
 *     advance, nextNodeId, updateSession, resetSession — are injected via the
 *     deps parameter.
 *   • Webhook-retry safe: Phase 1 is idempotent (re-renders existing state
 *     instead of regenerating), Phase 2 confirm guards on bookingRooms before
 *     writing output keys.
 *
 * New exports belong in ./ara/index.ts.
 */

export * from "./ara";
