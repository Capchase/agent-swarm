#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const IMAGES = [
  { name: "api", displayName: "API", baseTag: "agent-swarm-size-api:base", headTag: "agent-swarm-size-api:head" },
  {
    name: "worker",
    displayName: "Worker",
    baseTag: "agent-swarm-size-worker:base",
    headTag: "agent-swarm-size-worker:head",
  },
];

const args = parseArgs(process.argv.slice(2));
const mode = args.mode || "pr";
const thresholdPercent = Number(args.thresholdPercent || process.env.IMAGE_SIZE_THRESHOLD_PERCENT || 10);
const thresholdMb = Number(args.thresholdMb || process.env.IMAGE_SIZE_THRESHOLD_MB || 50);
const pingUser = args.pingUser || process.env.IMAGE_SIZE_PING_USER || "@tarasyarema";

if (!Number.isFinite(thresholdPercent) || thresholdPercent < 0) {
  throw new Error(`Invalid threshold percent: ${thresholdPercent}`);
}

if (!Number.isFinite(thresholdMb) || thresholdMb < 0) {
  throw new Error(`Invalid threshold MB: ${thresholdMb}`);
}

const measurements = args.input ? JSON.parse(readFileSync(args.input, "utf8")) : measureImages(mode);

if (mode === "history") {
  const historyFile = requiredArg("historyFile");
  appendHistory(historyFile, measurements);
} else if (mode === "pr") {
  const commentFile = requiredArg("commentFile");
  writeComment(commentFile, measurements);
} else {
  throw new Error(`Unknown mode: ${mode}`);
}

function measureImages(currentMode) {
  const measuredAt = new Date().toISOString();
  const result = {
    measuredAt,
    baseSha: args.baseSha || process.env.BASE_SHA || "",
    headSha: args.headSha || process.env.HEAD_SHA || process.env.GITHUB_SHA || "",
    images: {},
  };

  for (const image of IMAGES) {
    result.images[image.name] = {};
    if (currentMode === "pr") {
      result.images[image.name].base = measureTag(image.baseTag);
    }
    result.images[image.name].head = measureTag(image.headTag);
  }

  return result;
}

function measureTag(tag) {
  console.error(`Measuring ${tag}`);
  const uncompressedBytes = Number(
    execFileSync("docker", ["image", "inspect", tag, "--format", "{{.Size}}"], { encoding: "utf8" }).trim(),
  );
  console.error(`Measuring compressed size for ${tag}`);
  const compressedBytes = Number(
    execFileSync("bash", ["-o", "pipefail", "-c", `docker save ${shellQuote(tag)} | gzip -1 -n -c | wc -c`], {
      encoding: "utf8",
    }).trim(),
  );

  if (!Number.isFinite(uncompressedBytes) || !Number.isFinite(compressedBytes)) {
    throw new Error(`Failed to measure Docker image tag ${tag}`);
  }

  return { compressedBytes, uncompressedBytes };
}

function appendHistory(historyFile, measurements) {
  const record = {
    measuredAt: measurements.measuredAt,
    sha: measurements.headSha,
    images: Object.fromEntries(
      Object.entries(measurements.images).map(([name, values]) => [
        name,
        {
          compressedBytes: values.head.compressedBytes,
          uncompressedBytes: values.head.uncompressedBytes,
        },
      ]),
    ),
  };

  mkdirSync(dirname(historyFile), { recursive: true });
  let previous = "";
  try {
    previous = readFileSync(historyFile, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const prefix = previous && !previous.endsWith("\n") ? "\n" : "";
  writeFileSync(historyFile, `${previous}${prefix}${JSON.stringify(record)}\n`);
}

function writeComment(commentFile, measurements) {
  const rows = [];
  const notable = [];

  for (const image of IMAGES) {
    const values = measurements.images[image.name];
    if (!values?.base || !values?.head) {
      throw new Error(`Missing base/head measurements for ${image.name}`);
    }

    for (const metric of ["compressedBytes", "uncompressedBytes"]) {
      const baseBytes = values.base[metric];
      const headBytes = values.head[metric];
      const deltaBytes = headBytes - baseBytes;
      const deltaPercent = baseBytes > 0 ? (deltaBytes / baseBytes) * 100 : 0;
      const isCompressed = metric === "compressedBytes";
      const thresholdBytes = thresholdMb * 1024 * 1024;
      const thresholdPercentBytes = baseBytes * (thresholdPercent / 100);
      const effectiveThresholdBytes = Math.max(thresholdBytes, thresholdPercentBytes);
      const notableBump = isCompressed && deltaBytes > 0 && deltaBytes >= effectiveThresholdBytes;

      if (notableBump) {
        notable.push(`${image.displayName} compressed size grew by ${formatSignedMb(deltaBytes)} (${formatPercent(deltaPercent)})`);
      }

      rows.push({
        image: image.displayName,
        metric: isCompressed ? "Compressed pull estimate" : "Uncompressed image",
        baseBytes,
        headBytes,
        deltaBytes,
        deltaPercent,
        notableBump,
      });
    }
  }

  const banner =
    notable.length > 0
      ? `⚠️ ${pingUser} Docker image size bump crossed the configured threshold (${thresholdPercent}% or ${thresholdMb} MB compressed, whichever is larger): ${notable.join("; ")}.\n\n`
      : "";

  const body = `${banner}<!-- agent-swarm-image-size-report -->\n## Docker image size report\n\nComparing PR images against the PR base branch. Compressed size is measured as a deterministic local pull-size estimate using \`docker save <image> | gzip -1 -n -c | wc -c\`; uncompressed size comes from \`docker image inspect .Size\`.\n\n| Image | Metric | Base | PR | Delta | Delta % |\n|---|---|---:|---:|---:|---:|\n${rows
    .map(
      (row) =>
        `| ${row.image} | ${row.metric}${row.notableBump ? " ⚠️" : ""} | ${formatMb(row.baseBytes)} | ${formatMb(row.headBytes)} | ${formatSignedMb(row.deltaBytes)} | ${formatPercent(row.deltaPercent)} |`,
    )
    .join("\n")}\n\nThreshold: compressed growth at or above ${thresholdPercent}% or ${thresholdMb} MB, whichever is larger. Build cache uses GitHub Actions cache scopes per image.\n`;

  mkdirSync(dirname(commentFile), { recursive: true });
  writeFileSync(commentFile, body);
}

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatSignedMb(bytes) {
  const sign = bytes > 0 ? "+" : "";
  return `${sign}${formatMb(bytes)}`;
}

function formatPercent(value) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function requiredArg(name) {
  if (!args[name]) throw new Error(`Missing required --${kebabCase(name)}`);
  return args[name];
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = camelCase(arg.slice(2));
    const next = rawArgs[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function camelCase(value) {
  return value.replaceAll(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function kebabCase(value) {
  return value.replaceAll(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}
