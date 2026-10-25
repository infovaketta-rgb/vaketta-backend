/**
 * ara/config.ts — node.data → AllocationConfig resolution.
 *
 * Three tiers, highest first: injected hotel value → node.data → literal
 * default. Per-room-type overrides are applied later by `resolveRoomConfig`
 * (./allocator).
 */

import type {
  AdvancedRoomAllocationNodeData,
  AllocationConfig,
} from "./types";

/**
 * Build the node-level allocation config. `childAgeLimit` is now hotel-wide:
 * the injected HotelConfig value (when provided) wins over the legacy node-data
 * field, which is kept only as a fallback for older flows / direct-config tests.
 */
export function resolveConfig(
  data: AdvancedRoomAllocationNodeData,
  childAgeLimit?: number | null,
): AllocationConfig {
  return {
    baseAdults:       data.baseAdults       ?? 2,
    baseChildren:     data.baseChildren     ?? 0,
    maxAdults:        data.maxAdults        ?? 3,
    maxChildren:      data.maxChildren      ?? 1,
    extraAdultCharge: data.extraAdultCharge ?? 0,
    allowExtraBed:    data.allowExtraBed    ?? false,
    extraBedCharge:   data.extraBedCharge   ?? 0,
    childAgeLimit:    childAgeLimit ?? data.childAgeLimit ?? null,
  };
}
