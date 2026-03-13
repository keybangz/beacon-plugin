/**
 * Type definitions for bun:sqlite
 * Provides TypeScript support for Bun's built-in SQLite module
 */

declare module "bun:sqlite" {
  export interface Statement {
    bind(...params: unknown[]): this;
    run(...params: unknown[]): this;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    finalize(): void;
  }

  export interface Database {
    prepare(sql: string): Statement;
    exec(sql: string): void;
    query(sql: string): Statement;
    close(): void;
    transaction<T>(fn: () => T): () => T;
  }

  export interface DatabaseOptions {
    create?: boolean;
    readwrite?: boolean;
    readonly?: boolean;
  }

  export class Database {
    constructor(filename: string | null, options?: DatabaseOptions);
    prepare(sql: string): Statement;
    exec(sql: string): void;
    query(sql: string): Statement;
    close(): void;
    transaction<T>(fn: () => T): () => T;
  }

  export default Database;
}
