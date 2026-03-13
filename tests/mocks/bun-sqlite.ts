/**
 * Mock for bun:sqlite that delegates to better-sqlite3.
 * Used by Vitest (Node.js) so integration tests can run outside Bun.
 *
 * better-sqlite3 and bun:sqlite share the same synchronous API:
 *   exec(), prepare(), transaction(), close()
 * The constructor signature is identical: new Database(path, options?)
 */
import BetterSqlite3 from "better-sqlite3";

export const Database = BetterSqlite3;
export default BetterSqlite3;
