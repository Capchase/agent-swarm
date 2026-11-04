import { format } from "node:util";
import { createLogScrubber } from "./log-redaction";
import { installLogStreams } from "./log-streams";

/**
 * Process-wide console scrub: every `console.log/info/warn/error/debug` line
 * is formatted, scrubbed, and handed to the previous method as one string.
 *
 * Install it before anything else wraps the console (the OTel log bridge, the
 * Ink console patch), so every later wrapper sees only scrubbed text.
 */

const METHODS = [
  "log",
  "info",
  "warn",
  "error",
  "debug",
  "trace",
  "dir",
  "dirxml",
  "table",
  "assert",
  "count",
  "countReset",
  "group",
  "groupCollapsed",
  "time",
  "timeLog",
  "timeEnd",
] as const;
type ConsoleMethod = (typeof METHODS)[number];

const SCRUB_FAILED = "[console-scrub] failed to scrub log line";
const NESTED_SUPPRESSED = "[console-scrub] suppressed a log line written while formatting another";

let restore: (() => void) | undefined;

export function installConsoleScrub(options: { streams?: boolean } = {}): void {
  if (restore) return;
  const scrubbers = { stdout: createLogScrubber(), stderr: createLogScrubber() };
  const streams = options.streams ? installLogStreams(scrubbers) : undefined;
  const originalWrite = console.write;
  if (streams) {
    console.write = (...chunks) => {
      let bytes = 0;
      for (const chunk of chunks) {
        const buffer =
          typeof chunk === "string"
            ? Buffer.from(chunk)
            : chunk instanceof ArrayBuffer
              ? Buffer.from(chunk)
              : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        bytes += buffer.byteLength;
        process.stdout.write(buffer);
      }
      return bytes;
    };
  }
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();
  let scrubbing = false;
  for (const method of METHODS) {
    const original = console[method] as (...args: unknown[]) => void;
    originals.set(method, original);
    console[method] = (...args: unknown[]) => {
      if (method === "assert") {
        if (args[0]) return;
        args = args.slice(1);
      }
      if (args.length === 0) return original.call(console);
      // `format` runs custom inspectors synchronously, and one that logs lands
      // here mid-scrub. Its arguments are unscrubbed and formatting them again
      // could recurse, so fail closed with a fixed line instead.
      if (scrubbing) return original.call(console, NESTED_SUPPRESSED);
      scrubbing = true;
      let line: string;
      try {
        // `format` keeps %s/%d substitution, inspects objects and prints
        // Error stacks, so the scrub sees exactly what would be printed.
        const stream =
          method === "warn" ||
          method === "error" ||
          method === "assert" ||
          method === "time" ||
          method === "timeLog" ||
          method === "timeEnd"
            ? "stderr"
            : "stdout";
        const formatted = format(...args);
        line = streams ? streams.consoleLine(stream, formatted) : scrubbers[stream](formatted);
      } catch {
        // Never fall back to the raw arguments.
        line = SCRUB_FAILED;
      } finally {
        scrubbing = false;
      }
      if (method === "assert") original.call(console, false, line);
      else original.call(console, line);
    };
  }
  restore = () => {
    streams?.restore();
    console.write = originalWrite;
    for (const [method, original] of originals) console[method] = original;
    restore = undefined;
  };
}

/** Restore the console methods captured at install time (tests only). */
export function uninstallConsoleScrub(): void {
  restore?.();
}
