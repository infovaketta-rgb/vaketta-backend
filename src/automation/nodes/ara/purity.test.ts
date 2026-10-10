/**
 * ara/purity.test.ts — guards the module boundary, not behaviour.
 *
 * The whole point of ./ara is that the node's core can be unit-tested without
 * flowRuntime's module-load chain (Redis at import, Prisma, queues, AI). That
 * property is invisible at runtime and survives only if something checks it, so
 * this suite source-scans the directory instead of importing it.
 *
 * Same isolation principle as interpolate.ts / guestDate.ts / bookingAllocation.ts.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const ARA_ROOT = __dirname;

/**
 * Modules outside ./ara that may be referenced, and how.
 *
 * `type`  — the specifier is allowed ONLY on an `import type` / `export type`.
 *           A value import would pull the module's whole transitive graph in.
 * `value` — a real runtime import is allowed. Reserved for modules that are
 *           themselves dependency-free by design (interpolate.ts is 16 lines and
 *           imports nothing), i.e. the exception that proves the rule.
 */
const ALLOWED_EXTERNAL: Record<string, "type" | "value"> = {
  "../../flowTypes":                    "type",
  "../../../services/session.service":  "type",
  "../../interpolate":                  "value",
};

/** Every .ts file under ./ara except the test files. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

type Ref = { specifier: string; typeOnly: boolean; line: number };

/**
 * Every `import`/`export … from "x"` in a file, with whether it was type-only.
 * Deliberately a regex and not the TS compiler API: the check has to stay
 * cheap enough that nobody is tempted to delete it.
 */
function moduleRefs(src: string): Ref[] {
  const refs: Ref[] = [];
  const re = /^[ \t]*(?:import|export)[ \t]+(type[ \t]+)?[\s\S]*?from[ \t]+"([^"]+)";/gm;
  for (const m of src.matchAll(re)) {
    refs.push({
      specifier: m[2]!,
      typeOnly:  Boolean(m[1]),
      line:      src.slice(0, m.index).split("\n").length,
    });
  }
  // Bare side-effect imports (`import "x";`) and inline dynamic type imports
  // (`import("x").Foo`) bypass the form above — catch them too.
  for (const m of src.matchAll(/^[ \t]*import[ \t]+"([^"]+)";/gm)) {
    refs.push({ specifier: m[1]!, typeOnly: false, line: src.slice(0, m.index).split("\n").length });
  }
  for (const m of src.matchAll(/\bimport\("([^"]+)"\)/g)) {
    refs.push({ specifier: m[1]!, typeOnly: true, line: src.slice(0, m.index).split("\n").length });
  }
  return refs;
}

/** True when a relative specifier resolves to a path inside ./ara. */
function isInternal(file: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const resolved = resolve(dirname(file), specifier);
  return resolved === ARA_ROOT || resolved.startsWith(ARA_ROOT + sep);
}

const FILES = sourceFiles(ARA_ROOT);

describe("ara module purity", () => {
  it("finds the source files to scan", () => {
    // A broken walk would make every other case below vacuously pass.
    expect(FILES.length).toBeGreaterThan(10);
    expect(FILES.some((f) => f.endsWith("allocator.ts"))).toBe(true);
    expect(FILES.some((f) => f.endsWith(`phases${sep}phase1.ts`))).toBe(true);
  });

  it("only references allowed modules outside ./ara", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      for (const ref of moduleRefs(readFileSync(file, "utf8"))) {
        if (isInternal(file, ref.specifier)) continue;
        const allowed = ALLOWED_EXTERNAL[ref.specifier];
        if (!allowed) {
          violations.push(`${file}:${ref.line} → "${ref.specifier}" is not on the allowlist`);
          continue;
        }
        if (allowed === "type" && !ref.typeOnly) {
          violations.push(`${file}:${ref.line} → "${ref.specifier}" must be an \`import type\``);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("never imports the compatibility barrel (would be a cycle)", () => {
    const offenders = FILES.filter((file) =>
      moduleRefs(readFileSync(file, "utf8")).some((r) =>
        /(^|\/)\.\.\/advancedRoomAllocation$/.test(r.specifier) ||
        r.specifier === "../advancedRoomAllocation",
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("imports nothing that drags in prisma, redis, queues, the logger or AI", () => {
    // These are the actual load-chain hazards, named explicitly so the failure
    // message says WHY rather than just "not on the allowlist".
    const banned = /@prisma\/client|prismaClient|queue\/|\/redis|utils\/logger|ai\.service|outbound\.service|realtime\/emit/;
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const ref of moduleRefs(readFileSync(file, "utf8"))) {
        if (banned.test(ref.specifier)) offenders.push(`${file}:${ref.line} → "${ref.specifier}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("re-exports every module from the barrel", () => {
    // A module absent from index.ts is unreachable through the shim, which is
    // how an export silently disappears from the node's public surface.
    const barrel = readFileSync(join(ARA_ROOT, "index.ts"), "utf8");
    const exported = new Set(
      [...barrel.matchAll(/export \* from "\.\/([^"]+)";/g)].map((m) => m[1]!),
    );
    const missing = FILES
      .filter((f) => f !== join(ARA_ROOT, "index.ts"))
      .map((f) => f.slice(ARA_ROOT.length + 1).replace(/\.ts$/, "").split(sep).join("/"))
      .filter((name) => !exported.has(name));
    expect(missing).toEqual([]);
  });
});
