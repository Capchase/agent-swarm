/**
 * Startup backfill: detect script_embeddings rows with wrong-dimension
 * embeddings and re-embed only those rows in the background.
 */

import type { ScriptRecord } from "../../types";
import { getDb } from "../db";
import { EMBEDDING_DIMENSIONS } from "../memory/constants";
import { embedScript, getScriptEmbeddingProvider } from "./embeddings";

type ScriptRow = Omit<ScriptRecord, "isScratch" | "typeChecked"> & {
  isScratch: number;
  typeChecked: number;
};

const BATCH_SIZE = 20;

function vectorBytes(dimensions: number): number {
  return dimensions * Float32Array.BYTES_PER_ELEMENT;
}

function rowToScript(row: ScriptRow): ScriptRecord {
  return {
    ...row,
    scopeId: row.scopeId ?? null,
    isScratch: row.isScratch === 1,
    typeChecked: row.typeChecked === 1,
    createdByAgentId: row.createdByAgentId ?? null,
  };
}

function invalidCount(expectedVectorBytes: number): number {
  return (
    getDb()
      .prepare<{ count: number }, [number]>(
        `SELECT COUNT(*) as count FROM script_embeddings
         WHERE length(embedding) != ?`,
      )
      .get(expectedVectorBytes)?.count ?? 0
  );
}

function invalidScriptRows(expectedVectorBytes: number): ScriptRecord[] {
  return getDb()
    .prepare<ScriptRow, [number]>(
      `SELECT s.*
       FROM script_embeddings e
       JOIN scripts s ON s.id = e.scriptId
       WHERE s.isScratch = 0 AND length(e.embedding) != ?
       ORDER BY s.updatedAt ASC`,
    )
    .all(expectedVectorBytes)
    .map(rowToScript);
}

export async function runScriptsBootReembed(): Promise<void> {
  const provider = getScriptEmbeddingProvider();
  const expectedVectorBytes = vectorBytes(provider.dimensions || EMBEDDING_DIMENSIONS);
  const beforeInvalid = invalidCount(expectedVectorBytes);
  if (beforeInvalid === 0) {
    return;
  }

  const testEmbed = await provider.embed("test");
  if (!testEmbed) {
    console.warn(
      `[scripts-boot-reembed] skipped: ${beforeInvalid} wrong-dimension rows found but no OpenAI key configured`,
    );
    return;
  }

  console.log(
    `[scripts-boot-reembed] starting: ${beforeInvalid} rows with wrong embedding dimensions`,
  );

  const rows = invalidScriptRows(expectedVectorBytes);
  let reembedded = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    for (const script of batch) {
      try {
        await embedScript(script);
        reembedded++;
      } catch (err) {
        failed++;
        console.error(
          `[scripts-boot-reembed] script ${script.id} failed:`,
          (err as Error).message,
        );
      }
    }
  }

  const afterInvalid = invalidCount(expectedVectorBytes);
  console.log(
    `[scripts-boot-reembed] complete: reembedded=${reembedded} failed=${failed} remaining_invalid=${afterInvalid}`,
  );
}
