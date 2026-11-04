import { isSensitiveKey, scrubSecrets } from "./secret-scrubber";

const REDACTED = "[REDACTED]";
const BEGIN = /-----BEGIN [A-Z0-9 ]{1,64}-----/;
const END = /-----END [A-Z0-9 ]{1,64}-----/;
const QUOTED_ASSIGNMENT = /\b([A-Za-z_][\w.-]*)(\s*=\s*)(["'])/g;

/** One instance per output stream. PEM state survives separate console calls. */
export function createLogScrubber(): (text: string) => string {
  let inPem = false;
  let secretQuote: string | undefined;
  let escaped = false;
  return (text) => {
    let remaining = text;
    let safe = "";
    while (remaining) {
      if (inPem) {
        const end = END.exec(remaining);
        if (!end) break;
        remaining = remaining.slice(end.index + end[0].length);
        inPem = false;
      } else if (secretQuote) {
        let end = -1;
        for (let i = 0; i < remaining.length; i++) {
          const char = remaining[i];
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === secretQuote) {
            end = i;
            break;
          }
        }
        if (end < 0) break;
        remaining = remaining.slice(end + 1);
        secretQuote = undefined;
      } else {
        const begin = remaining.includes("-----BEGIN ") ? BEGIN.exec(remaining) : null;
        QUOTED_ASSIGNMENT.lastIndex = 0;
        let assignment = remaining.includes("=") ? QUOTED_ASSIGNMENT.exec(remaining) : null;
        while (assignment && !isSensitiveKey(assignment[1] ?? "")) {
          assignment = QUOTED_ASSIGNMENT.exec(remaining);
        }
        if (assignment && (!begin || assignment.index < begin.index)) {
          safe += remaining.slice(0, assignment.index) + assignment[1] + assignment[2] + REDACTED;
          remaining = remaining.slice(assignment.index + assignment[0].length);
          secretQuote = assignment[3];
          continue;
        }
        if (!begin) {
          safe += remaining;
          break;
        }
        safe += remaining.slice(0, begin.index) + REDACTED;
        remaining = remaining.slice(begin.index + begin[0].length);
        inPem = true;
      }
    }
    // Logs have no code-preservation exemptions: even short KEY=value
    // credentials must be removed. Keep stored-text scrubbing unchanged.
    if (safe.includes("="))
      safe = safe.replace(
        /\b([A-Za-z_][\w.-]*)(\s*=\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/g,
        (match, key: string, separator: string) =>
          isSensitiveKey(key) ? `${key}${separator}${REDACTED}` : match,
      );
    safe = safe.replace(/\b(?:xox[a-z]-|sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+/g, REDACTED);
    safe = safe.replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@?#"'\\]*@/gi, `$1${REDACTED}@`);
    return scrubSecrets(safe).replace(/\[REDACTED:[^\]\r\n]+\]/g, REDACTED);
  };
}

/** Never derive the identifier from content: prompts can contain low-entropy secrets. */
export function describeLogContent(text: string, id: string = crypto.randomUUID()): string {
  return `id=${id} chars=${text.length}`;
}
