/**
 * Integration tests for the reindex tool execute() function.
 * Mocks the embedding API so no Ollama/network is required.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

// ── Resolve repo root ────────────────────────────────────────────────────────
const _currentDir: string =
  typeof (import.meta as any).dir === "string"
    ? (import.meta as any).dir
    : dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(_currentDir, "../..");
const TEST_STORAGE = join(REPO_ROOT, ".opencode", ".beacon-test");

// ── Mock the embedding HTTP call before importing the tool ───────────────────
const MOCK_DIMENSIONS = 384;

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
  const urlStr = String(
    typeof url === "object" && "url" in url ? (url as Request).url : url
  );
  if (urlStr.includes("/embeddings")) {
    const body = JSON.parse((init?.body as string) ?? "{}");
    const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
    const data = inputs.map((_, i) => ({
      object: "embedding",
      index: i,
      embedding: Array.from({ length: MOCK_DIMENSIONS }, (_, j) => Math.sin(i + j) * 0.1),
    }));
    return new Response(
      JSON.stringify({
        object: "list",
        data,
        model: body.model,
        usage: { prompt_tokens: 0, total_tokens: 0 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  return originalFetch(url as any, init);
};

// ── Lazy-load the tool (after fetch mock is in place) ───────────────────────
let reindexTool: any;

beforeAll(async () => {
  // Clean up any previous test run
  if (existsSync(TEST_STORAGE)) {
    rmSync(TEST_STORAGE, { recursive: true, force: true });
  }

  // Patch config to use the test storage path
  mkdirSync(join(REPO_ROOT, ".opencode"), { recursive: true });
  const testConfigPath = join(REPO_ROOT, ".opencode", "beacon.json");
  const hadExistingConfig = existsSync(testConfigPath);
  const existingConfig = hadExistingConfig ? readFileSync(testConfigPath, "utf-8") : null;

  writeFileSync(
    testConfigPath,
    JSON.stringify({ storage: { path: ".opencode/.beacon-test" } })
  );

  // Import the tool (fetch is already mocked)
  const mod = await import("../../.opencode/tools/reindex.ts");
  reindexTool = (mod as any).default;

  // Restore original config after import (tool uses config at runtime)
  if (hadExistingConfig && existingConfig) {
    writeFileSync(testConfigPath, existingConfig);
  } else if (!hadExistingConfig) {
    rmSync(testConfigPath, { force: true });
  }

  // Re-write test config so execute() uses the test storage
  writeFileSync(
    testConfigPath,
    JSON.stringify({ storage: { path: ".opencode/.beacon-test" } })
  );
});

afterAll(() => {
  // Restore original config
  const testConfigPath = join(REPO_ROOT, ".opencode", "beacon.json");
  const savedConfig = join(REPO_ROOT, ".opencode", "beacon.json.bak");
  if (existsSync(savedConfig)) {
    writeFileSync(testConfigPath, readFileSync(savedConfig, "utf-8"));
    rmSync(savedConfig, { force: true });
  } else {
    // Remove the test config we wrote (restore to prior state is handled by the test harness)
    rmSync(testConfigPath, { force: true });
  }

  // Clean up test DB
  if (existsSync(TEST_STORAGE)) {
    rmSync(TEST_STORAGE, { recursive: true, force: true });
  }

  // Restore fetch
  globalThis.fetch = originalFetch;
});

describe("reindex tool", () => {
  let raw: string;
  let result: any;

  it("execute() returns a string", async () => {
    raw = await reindexTool.execute({ confirm: true }, { worktree: REPO_ROOT });
    expect(typeof raw).toBe("string");
  });

  it("result is valid JSON", () => {
    result = JSON.parse(raw);
    expect(result).toBeTruthy();
  });

  it("result has status field", () => {
    expect(result).toHaveProperty("status");
  });

  it("status is success", () => {
    expect(result.status).toBe("success");
  });

  it("files_indexed is a non-negative number", () => {
    expect(typeof result.files_indexed).toBe("number");
    expect(result.files_indexed).toBeGreaterThanOrEqual(0);
  });

  it("at least 1 file was indexed", () => {
    expect(result.files_indexed).toBeGreaterThan(0);
  });

  it("total_chunks is a non-negative number", () => {
    expect(typeof result.total_chunks).toBe("number");
    expect(result.total_chunks).toBeGreaterThanOrEqual(0);
  });

  it("at least 1 chunk was created", () => {
    expect(result.total_chunks).toBeGreaterThan(0);
  });

  it("result has statistics sub-object", () => {
    expect(result.statistics).toBeTruthy();
    expect(typeof result.statistics).toBe("object");
  });

  it("duration_seconds is a non-negative number", () => {
    expect(typeof result.duration_seconds).toBe("number");
    expect(result.duration_seconds).toBeGreaterThanOrEqual(0);
  });

  it("database file was created", () => {
    const dbFile = join(TEST_STORAGE, "embeddings.db");
    expect(existsSync(dbFile)).toBe(true);
  });
});
