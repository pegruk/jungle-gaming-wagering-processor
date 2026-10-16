import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { IdempotencyEngine } from "../../../src/domain/services/idempotency-engine";
import { createTestDatabase, withClient, type TestDatabase } from "../../helpers/database";

describe("IdempotencyEngine against PostgreSQL", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    // Generic SQL effect: financial invariants are tested through FinanceService.
    await db.pool.query("CREATE TABLE test_effects (id TEXT PRIMARY KEY, player_id TEXT, currency TEXT, balance NUMERIC(16,2) DEFAULT 0)");
  });
  afterAll(async () => { await db?.close(); });

  it("executes one effect and replays one historical response across 50 clients", async () => {
    const id = crypto.randomUUID();
    await db.pool.query("INSERT INTO test_effects (id, player_id, currency, balance) VALUES ($1, $1, 'BRL', '0.00')", [id]);
    const attempts = await Promise.allSettled(Array.from({ length: 50 }, () => withClient(db.pool, (client) =>
      IdempotencyEngine.process(client, id, "provider-a", { amount: "1.00" }, async () => {
        await client.query("SELECT pg_sleep(0.1)");
        const result = await client.query("UPDATE test_effects SET balance = balance + '1.00' WHERE id = $1 RETURNING balance", [id]);
        return { status: 200, body: { balance: result.rows[0].balance } };
      }),
    )));
    const results = attempts.filter((attempt) => attempt.status === "fulfilled").map((attempt) => attempt.value);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(0);
    expect(results.filter((result) => !result.isReplay)).toHaveLength(1);
    expect(results.filter((result) => result.isReplay)).toHaveLength(49);
    expect(results.every((result) => JSON.stringify(result.body) === JSON.stringify({ balance: "1.00" }))).toBe(true);
    const wallet = await db.pool.query("SELECT balance FROM test_effects WHERE id = $1", [id]);
    expect(wallet.rows[0].balance).toBe("1.00");
  }, 15000);

  it("rolls back a failed operation and leaves the key available for a retry", async () => {
    const id = crypto.randomUUID();
    await expect(withClient(db.pool, (client) => IdempotencyEngine.process(client, id, "provider-a", {}, async () => {
      await client.query("INSERT INTO test_effects (id, player_id, currency) VALUES ($1, $1, 'BRL')", [id]);
      throw new Error("simulated crash before receipt");
    }))).rejects.toThrow("simulated crash");
    const wallets = await db.pool.query("SELECT id FROM test_effects WHERE id = $1", [id]);
    const receipts = await db.pool.query("SELECT key FROM idempotency_keys WHERE key = $1", [id]);
    expect(wallets.rows).toHaveLength(0);
    expect(receipts.rows).toHaveLength(0);
    const retry = await withClient(db.pool, (client) => IdempotencyEngine.process(client, id, "provider-a", {}, async () => ({ status: 200, body: {} })));
    expect(retry.isReplay).toBe(false);
  });

  it("rejects reuse by another provider even when the payload matches", async () => {
    const key = crypto.randomUUID();
    await withClient(db.pool, (client) => IdempotencyEngine.process(client, key, "provider-a", {}, async () => ({ status: 200, body: {} })));
    await expect(withClient(db.pool, (client) => IdempotencyEngine.process(client, key, "provider-b", {}, async () => {
      throw new Error("must not execute");
    }))).rejects.toThrow("IdempotencyConflictException");
  });

  it("rejects a divergent payload without executing another effect", async () => {
    const key = crypto.randomUUID();
    await withClient(db.pool, (client) => IdempotencyEngine.process(client, key, "provider-a", { amount: "1.00" }, async () => ({ status: 200, body: {} })));
    await expect(withClient(db.pool, (client) => IdempotencyEngine.process(client, key, "provider-a", { amount: "2.00" }, async () => {
      throw new Error("must not execute");
    }))).rejects.toThrow("IdempotencyConflictException");
  });
});
