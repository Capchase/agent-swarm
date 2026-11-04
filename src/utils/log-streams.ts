import { StringDecoder } from "node:string_decoder";
import type { createLogScrubber } from "./log-redaction";

const MAX_LINE_CHARS = 64 * 1024;

/**
 * Daemon log streams only. Protocol stdout (MCP, hooks, token commands) must
 * remain byte-exact and must not install this wrapper.
 */
export function installLogStreams(scrubbers: {
  stdout: ReturnType<typeof createLogScrubber>;
  stderr: ReturnType<typeof createLogScrubber>;
}): { restore(): void; consoleLine(stream: "stdout" | "stderr", text: string): string } {
  const restores: Array<() => void> = [];
  const consumers = new Map<"stdout" | "stderr", (text: string) => string>();
  for (const name of ["stdout", "stderr"] as const) {
    const stream = process[name];
    const original = stream.write;
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let oversized = false;
    const scrub = scrubbers[name];
    const consume = (text: string) => {
      let output = "";
      try {
        for (const part of text.split(/(?<=\n)/)) {
          const complete = part.endsWith("\n");
          pending += part;
          if (oversized || pending.length > MAX_LINE_CHARS) {
            // Still consume armor so an oversized PEM cannot expose its tail.
            scrub(pending);
            // Overlap armor markers split across subsequent writes. This
            // suffix stays private and is never emitted for oversized lines.
            pending = pending.slice(-128);
            oversized = true;
          }
          if (complete) {
            output += oversized ? "[REDACTED]\n" : scrub(pending);
            pending = "";
            oversized = false;
          }
        }
      } catch {
        pending = "";
        output = "[log-scrub] failed to scrub log line\n";
      }
      return output;
    };
    consumers.set(name, consume);
    stream.write = ((chunk, encoding, callback) => {
      const done = typeof encoding === "function" ? encoding : callback;
      const text = decoder.write(
        typeof chunk === "string"
          ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8")
          : Buffer.from(chunk),
      );
      const output = consume(text);
      if (output) return original.call(stream, output, "utf8", done);
      // A partial line stays private until its terminator arrives. Never
      // flush it on a timer: the next write may finish a secret or PEM marker.
      if (done) queueMicrotask(done);
      return true;
    }) as typeof stream.write;
    const onExit = () => {
      if (pending || oversized) original.call(stream, "[REDACTED]\n");
    };
    process.on("exit", onExit);
    restores.push(() => {
      stream.write = original;
      process.off("exit", onExit);
    });
  }
  return {
    restore() {
      for (const restore of restores) restore();
    },
    consoleLine(stream, text) {
      // Bun console bypasses stream.write. Fold any pending raw bytes into
      // this write so a marker/token split between both APIs stays private.
      return consumers.get(stream)?.(`${text}\n`).replace(/\n$/, "") ?? "";
    },
  };
}
