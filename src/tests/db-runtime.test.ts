import { afterEach, describe, expect, test } from "bun:test";
import * as facade from "../be/db";
import * as runtime from "../be/db/runtime";

const runtimeExports = [
  "__resetSqliteVecExtensionPathCacheForTests",
  "closeDb",
  "getDb",
  "getDbClient",
  "initDb",
  "isSqliteVecAvailable",
  "resolveSqliteVecExtensionPath",
] as const;

afterEach(() => runtime.closeDb());

describe("database runtime facade", () => {
  test("re-exports the same seven runtime bindings", () => {
    expect(Object.keys(runtime).sort()).toEqual([...runtimeExports].sort());
    expect(facade.__resetSqliteVecExtensionPathCacheForTests).toBe(
      runtime.__resetSqliteVecExtensionPathCacheForTests,
    );
    expect(facade.closeDb).toBe(runtime.closeDb);
    expect(facade.getDb).toBe(runtime.getDb);
    expect(facade.getDbClient).toBe(runtime.getDbClient);
    expect(facade.initDb).toBe(runtime.initDb);
    expect(facade.isSqliteVecAvailable).toBe(runtime.isSqliteVecAvailable);
    expect(facade.resolveSqliteVecExtensionPath).toBe(runtime.resolveSqliteVecExtensionPath);
  });

  test("shares one connection and reuses the async client across close/reopen", async () => {
    const first = runtime.initDb(":memory:");
    expect(facade.getDb()).toBe(first);
    expect(facade.initDb(":memory:")).toBe(first);
    const client = facade.getDbClient();
    expect(runtime.getDbClient()).toBe(client);
    await client.run("CREATE TABLE runtime_probe (value TEXT)");
    await client.run("INSERT INTO runtime_probe VALUES (?)", ["first"]);
    expect(await client.get("SELECT value FROM runtime_probe")).toEqual({ value: "first" });

    facade.closeDb();
    expect(runtime.isSqliteVecAvailable()).toBe(false);
    runtime.closeDb();
    const second = facade.initDb(":memory:");
    expect(second).not.toBe(first);
    expect(runtime.getDb()).toBe(second);
    expect(runtime.getDbClient()).toBe(client);
    expect(
      await client.get("SELECT name FROM sqlite_master WHERE name = 'runtime_probe'"),
    ).toBeNull();
    await client.run("CREATE TABLE runtime_probe (value TEXT)");
    await client.run("INSERT INTO runtime_probe VALUES (?)", ["second"]);
    expect(await client.get("SELECT value FROM runtime_probe")).toEqual({ value: "second" });
  });

  test("sets auto_vacuum = INCREMENTAL on a freshly created database", () => {
    // Regression guard: auto_vacuum is a file-format property fixed at
    // creation time and is silently ignored once journal_mode is WAL, so a
    // later reordering of the pragma block would pass every other test while
    // quietly losing this setting on every new deployment.
    const globals = globalThis as typeof globalThis & { __testMigrationTemplate?: Uint8Array };
    const template = globals.__testMigrationTemplate;
    runtime.closeDb();
    globals.__testMigrationTemplate = undefined;
    try {
      const database = runtime.initDb(":memory:");
      const row = database.query("PRAGMA auto_vacuum;").get() as { auto_vacuum: number };
      expect(row.auto_vacuum).toBe(2); // 2 == INCREMENTAL
    } finally {
      runtime.closeDb();
      globals.__testMigrationTemplate = template;
    }
  });

  test("cold initialization still seeds templates", () => {
    const globals = globalThis as typeof globalThis & { __testMigrationTemplate?: Uint8Array };
    const template = globals.__testMigrationTemplate;
    runtime.closeDb();
    globals.__testMigrationTemplate = undefined;
    try {
      runtime.initDb(":memory:");
      const templates = facade.getPromptTemplates({ scope: "global" });
      expect(templates.length).toBeGreaterThan(0);
    } finally {
      runtime.closeDb();
      globals.__testMigrationTemplate = template;
    }
  });
});
