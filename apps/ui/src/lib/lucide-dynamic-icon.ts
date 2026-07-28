/**
 * Isolated in its own module so `lucide-react/dynamic`'s ~1,900-entry lazy
 * icon-loader map only downloads for agents whose stored avatar icon falls
 * outside the small eager `AVATAR_ICON_CATALOG` (agent-icon.ts) — reached via
 * a dynamic `import()`, never a static one, so ordinary avatar rendering
 * never pays for it.
 */
export { DynamicIcon } from "lucide-react/dynamic";
