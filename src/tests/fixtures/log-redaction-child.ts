import "../../utils/console-scrub-install";
import { installConsoleScrub } from "../../utils/console-scrub";
import { prettyPrintLine, prettyPrintStderr } from "../../utils/pretty-print";
import {
  CREDENTIAL_CASES,
  PEM,
  PEM_TAIL,
  PROMPT_CASES,
  PROMPT_SENTINEL,
} from "./log-redaction-cases";

installConsoleScrub({ streams: true });
for (const method of ["log", "info", "debug", "warn", "error", "trace", "dir", "table"] as const) {
  console[method](PEM);
  for (const fixture of CREDENTIAL_CASES) console[method](fixture.wrap(fixture.secret));
}
console.assert(false, CREDENTIAL_CASES[0]?.secret);
const label = CREDENTIAL_CASES[0]?.secret;
console.count(label);
console.countReset(label);
console.group(label);
console.groupEnd();
console.groupCollapsed(label);
console.groupEnd();
console.time(label);
console.timeLog(label);
console.timeEnd(label);
console.time(PEM_TAIL);
process.stderr.write("-----BEGIN PRIVATE KEY-----\n");
console.timeLog(PEM_TAIL);
console.timeEnd(PEM_TAIL);
process.stderr.write("-----END PRIVATE KEY-----\n");
process.stdout.write("-----BEGIN PRIVATE KEY-----\n");
console.trace(PEM_TAIL);
process.stdout.write("-----END PRIVATE KEY-----\n");
for (const char of `${CREDENTIAL_CASES[0]?.secret}\n`) console.write(char);

for (const stream of [process.stdout, process.stderr]) {
  const log = stream === process.stdout ? console.log : console.error;
  stream.write("-----BEGIN PRIVATE KEY-----");
  log(PEM_TAIL);
  stream.write("-----END PRIVATE KEY-----\n");
  stream.write("ghp_");
  log("Q".repeat(36));
  // Quoted assignment state also spans line and API boundaries.
  stream.write('password="first\n');
  log(PEM_TAIL);
  stream.write('second"\n');
  // Every byte boundary includes BEGIN/END marker splits and short tails.
  for (const char of `${PEM}\n`) stream.write(char);
  for (const fixture of CREDENTIAL_CASES) {
    for (const char of `${fixture.wrap(fixture.secret)}\n`) stream.write(char);
  }
  stream.write(Buffer.from(`unicode é ${PEM}\n`));
  stream.write(Buffer.from(`${CREDENTIAL_CASES[0]?.secret}\n`).toString("hex"), "hex");
  stream.write(`-----BEGIN PRIVATE KEY-----\n${"X".repeat(70_000)}`);
  for (const char of "-----END PRIVATE KEY-----\n") stream.write(char);
  await new Promise<void>((resolve) => stream.write("normal diagnostic survives\n", resolve));
  await new Promise<void>((resolve) => stream.write("buffered", resolve));
  stream.write(" callback\n");
  stream.write("write callbacks completed\n");
}

for (const event of [
  { type: "assistant", message: { content: [{ type: "text", text: PROMPT_SENTINEL }] } },
  { type: "assistant", message: { content: [{ type: "thinking", thinking: PROMPT_SENTINEL }] } },
  {
    type: "assistant",
    message: { content: [{ type: "tool_use", input: { prompt: PROMPT_SENTINEL } }] },
  },
  { type: "user", tool_use_result: PROMPT_SENTINEL },
  { type: "result", result: PROMPT_SENTINEL },
  { type: "system", subtype: "hook_response", stdout: PROMPT_SENTINEL },
  { type: "error", error: PROMPT_SENTINEL },
  { type: "unknown", body: PROMPT_SENTINEL },
])
  prettyPrintLine(JSON.stringify(event), "worker");
prettyPrintLine(PROMPT_SENTINEL, "worker");
prettyPrintStderr(PROMPT_SENTINEL, "worker");
for (const text of PROMPT_CASES) {
  prettyPrintLine(JSON.stringify({ type: "result", result: text }), "lead");
  prettyPrintLine(text, "worker");
  prettyPrintStderr(text, "worker");
}

// Unterminated fragments are never flushed as raw text, even at process exit.
process.stdout.write(`-----BEGIN PRIVATE KEY-----\n${PEM_TAIL}`);
process.stderr.write(`-----BEGIN PRIVATE KEY-----\n${PEM_TAIL}`);
