import { getDbClient } from "./runtime";

/**
 * Memory IDs that appear anywhere in a task's session logs. SQLite scans the rows and returns
 * a boolean per ID, so a task with a huge log set never loads its content into the heap.
 */
export async function findCitedMemoryIdsInSessionLogs(
  taskId: string,
  memoryIds: string[],
): Promise<string[]> {
  const cited: string[] = [];
  for (const memoryId of memoryIds) {
    const row = await getDbClient().get<{ one: number }>(
      "SELECT 1 AS one FROM session_logs WHERE taskId = ? AND instr(content, ?) > 0 LIMIT 1",
      [taskId, memoryId],
    );
    if (row) cited.push(memoryId);
  }
  return cited;
}
