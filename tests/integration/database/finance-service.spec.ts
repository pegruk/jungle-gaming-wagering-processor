import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TransactionType, TransactionStatus } from "../../../src/domain/entities/wager-transaction";
import { createTestApplication } from "../../helpers/application";

describe("Financial use case with MikroORM and PostgreSQL", () => {
  let app: Awaited<ReturnType<typeof createTestApplication>>;
  const context = { correlationId: "integration" };
  beforeAll(async () => { app = await createTestApplication(); });
  afterAll(async () => { await app?.close(); });

  async function setup() {
    const wallet = await app.service.createWallet({ playerId: crypto.randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" } }, context);
    const request = { providerId: "provider", externalTransactionId: crypto.randomUUID(), playerId: wallet.playerId,
      walletId: wallet.id, roundId: "round", gameId: "game", kind: TransactionType.BET, money: { amount: "80.00", currency: "BRL" } };
    return { wallet, request };
  }

  async function reconcile(id: string) {
    const result = await app.pool.query(`SELECT w.balance,
      coalesce(sum(CASE WHEN l.direction='CREDIT' THEN l.amount ELSE -l.amount END),0)::numeric(16,2)::text AS calculated
      FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id=w.id WHERE w.id=$1 GROUP BY w.id`, [id]);
    expect(result.rows[0].balance).toBe(result.rows[0].calculated);
  }

  it("records opening credit, applies BET and replays the historical balance", async () => {
    const { wallet, request } = await setup();
    const first = await app.service.submit(request, request.externalTransactionId, context);
    expect(first).toMatchObject({ status: "PROCESSED", balance: { amount: "20.00", currency: "BRL" }, idempotentReplay: false });
    await app.service.submit({ ...request, externalTransactionId: "win", kind: TransactionType.WIN }, `win:${wallet.id}`, context);
    const replay = await app.service.submit(request, request.externalTransactionId, context);
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    await reconcile(wallet.id);
  });

  it("processes exactly one of two simultaneous 80.00 bets against 100.00", async () => {
    const { wallet, request } = await setup();
    const results = await Promise.all([request, { ...request, externalTransactionId: crypto.randomUUID() }].map((input) => app.service.submit(input, input.externalTransactionId, context)));
    expect(results.map((result) => result.status).sort()).toEqual([TransactionStatus.PROCESSED, TransactionStatus.REJECTED]);
    expect(results.find((result) => result.status === "REJECTED")?.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect((await app.pool.query("SELECT balance FROM wallets WHERE id=$1", [wallet.id])).rows[0].balance).toBe("20.00");
    expect((await app.pool.query("SELECT count(*)::integer AS count FROM wallet_ledger_entries WHERE wallet_id=$1 AND direction='DEBIT'", [wallet.id])).rows[0].count).toBe(1);
    await reconcile(wallet.id);
  });

  it("deduplicates 50 submissions and atomically includes inbox and outbox", async () => {
    const { wallet, request } = await setup();
    const results = await Promise.all(Array.from({ length: 50 }, () => app.service.submit(request, request.externalTransactionId, context, { consumerName: "test", messageId: "msg-" + wallet.id })));
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect((await app.pool.query("SELECT count(*)::integer AS count FROM inbox_messages WHERE message_id=$1", ["msg-" + wallet.id])).rows[0].count).toBe(1);
    expect((await app.pool.query("SELECT count(*)::integer AS count FROM outbox_messages WHERE aggregate_id=$1", [wallet.id])).rows[0].count).toBe(4);
    await reconcile(wallet.id);
  }, 15000);

  it("waits for an out-of-order REFUND and applies it once after the BET", async () => {
    const { wallet, request } = await setup();
    const refund = { ...request, externalTransactionId: "refund", kind: TransactionType.REFUND, referenceExternalTransactionId: request.externalTransactionId };
    expect((await app.service.submit(refund, "refund:" + wallet.id, context)).status).toBe(TransactionStatus.PENDING_REFERENCE);
    await app.service.submit(request, request.externalTransactionId, context);
    await app.service.retryPending();
    expect((await app.service.submit(refund, "refund:" + wallet.id, context))).toMatchObject({ status: "PROCESSED", balance: { amount: "100.00" } });
    await reconcile(wallet.id);
  });
});
