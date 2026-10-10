/**
 * ara/index.ts — the node's public surface.
 *
 * `../advancedRoomAllocation.ts` is a one-line re-export of this barrel, so
 * flowRuntime, planList, modifyLists and the test suite keep their existing
 * import paths. Add new modules here, never to the compatibility shim.
 */

export * from "./types";
export * from "./constants";
export * from "./money";
export * from "./allocator";
export * from "./plans";
export * from "./plans.legacy";
export * from "./appliers";
export * from "./ages";
export * from "./render";
export * from "./config";
export * from "./inventory";
export * from "./dates";
export * from "./state";
export * from "./keywords";
export * from "./phases/phase1";
export * from "./phases/ages.phase";
export * from "./phases/confirm.phase";
export * from "./handler";
