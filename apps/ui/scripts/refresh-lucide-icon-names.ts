#!/usr/bin/env bun
/**
 * Regenerates `src/lib/lucide-icon-names.generated.ts` — the full, deduped
 * set of kebab-case icon names resolvable via `lucide-react/dynamic`'s
 * `DynamicIcon`. Run after bumping `lucide-react`:
 * `cd apps/ui && bun run refresh:lucide-icon-names`.
 *
 * Dedup strategy: two kebab-case names count as the same icon when their
 * lazy loaders resolve to the identical component reference (deprecated
 * lucide aliases re-export the same module) — verified by actually awaiting
 * every loader, not by guessing from naming conventions. The first name
 * encountered in `dynamicIconImports`'s insertion order wins as canonical,
 * matching lucide's own generation order (current name before its aliases).
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
// No published types for the raw per-icon import map (only the derived
// DynamicIcon/iconNames wrapper is typed).
// @ts-expect-error
import dynamicIconImports from "lucide-react/dynamicIconImports";
import lucidePackageJson from "lucide-react/package.json" with { type: "json" };

const OUTPUT_PATH = path.join(
  import.meta.dir,
  "..",
  "src",
  "lib",
  "lucide-icon-names.generated.ts",
);

async function main() {
  const allNames = Object.keys(dynamicIconImports);
  const seenComponents = new Set<unknown>();
  const canonicalNames: string[] = [];

  for (const name of allNames) {
    const mod = await dynamicIconImports[name]();
    const component = mod.default;
    if (seenComponents.has(component)) continue;
    seenComponents.add(component);
    canonicalNames.push(name);
  }

  canonicalNames.sort();

  const header = `/**
 * GENERATED FILE — do not hand-edit.
 * Regenerate with \`bun run refresh:lucide-icon-names\` (apps/ui) after
 * bumping \`lucide-react\`. Source: lucide-react@${lucidePackageJson.version}
 * (${allNames.length} raw names, ${canonicalNames.length} deduped canonical icons).
 */
`;
  const body = `export const LUCIDE_ICON_NAMES: readonly string[] = ${JSON.stringify(canonicalNames, null, 2)};\n`;

  writeFileSync(OUTPUT_PATH, header + body);
  // JSON.stringify omits the trailing comma Biome's formatter requires —
  // format through Biome itself (not a hand-rolled serializer) so this stays
  // correct across future Biome config changes.
  await Bun.$`bunx biome format --write ${OUTPUT_PATH}`;
  console.log(
    `Wrote ${canonicalNames.length} canonical icon names (deduped from ${allNames.length} raw names, lucide-react@${lucidePackageJson.version}) to ${OUTPUT_PATH}`,
  );
}

main();
