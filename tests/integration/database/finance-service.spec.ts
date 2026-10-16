import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TransactionType, TransactionStatus } from "../../../src/domain/entities/wager-transaction";
import { createTestApplication } from "../../helpers/application";
import { FinanceService } from "../../../src/application/finance.service";

describe("Financial use case with MikroORM and PostgreSQL", () => {
  let app: Awaited<ReturnType<typeof createTestApplication>>;
  const context = { correlationId: "integration" };
  beforeAll(async () => {
    app = await createTestApplication();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function setup() {
    const wallet = await app.service.createWallet(
      { playerId: crypto.randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" } },
      context,
    );
    const request = {
      providerId: "provider",
      externalTransactionId: crypto.randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round",
      gameId: "game",
      kind: TransactionType.BET,
      money: { amount: "80.00", currency: "BRL" },
    };
    return { wallet, request };
  }

  async function reconcile(id: string) {
    const result = await app.pool.query(
      `SELECT w.balance,
      coalesce(sum(CASE WHEN l.direction='CREDIT' THEN l.amount ELSE -l.amount END),0)::numeric(16,2)::text AS calculated
      FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id=w.id WHERE w.id=$1 GROUP BY w.id`,
      [id],
    );
    expect(result.rows[0].balance).toBe(result.rows[0].calculated);
  }

  it("records opening credit, applies BET and replays the historical balance", async () => {
    const { wallet, request } = await setup();
    const first = await app.service.submit(request, request.externalTransactionId, context);
    expect(first).toMatchObject({
      status: "PROCESSED",
      balance: { amount: "20.00", currency: "BRL" },
      idempotentReplay: false,
    });

    await app.service.submit(
      { ...request, externalTransactionId: "win", kind: TransactionType.WIN },
      `win:${wallet.id}`,
      context,
    );
    const replay = await app.service.submit(request, request.externalTransactionId, context);
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    await reconcile(wallet.id);
  });

  it("processes exactly one of two simultaneous 80.00 bets against 100.00", async () => {
    const { wallet, request } = await setup();
    const results = await Promise.all(
      [request, { ...request, externalTransactionId: crypto.randomUUID() }].map((input) =>
        app.service.submit(input, input.externalTransactionId, context),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([
      TransactionStatus.PROCESSED,
      TransactionStatus.REJECTED,
    ]);

    expect(results.find((result) => result.status === "REJECTED")?.failureCode).toBe(
      "INSUFFICIENT_FUNDS",
    );

    expect(
      (await app.pool.query("SELECT balance FROM wallets WHERE id=$1", [wallet.id])).rows[0]
        .balance,
    ).toBe("20.00");

    expect(
      (
        await app.pool.query(
          "SELECT count(*)::integer AS count FROM wallet_ledger_entries WHERE wallet_id=$1 AND direction='DEBIT'",
          [wallet.id],
        )
      ).rows[0].count,
    ).toBe(1);
    await reconcile(wallet.id);
  });

  it("deduplicates 50 submissions and atomically includes inbox and outbox", async () => {
    const { wallet, request } = await setup();
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        app.service.submit(request, request.externalTransactionId, context, {
          consumerName: "test",
          messageId: "msg-" + wallet.id,
        }),
      ),
    );
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(
      (
        await app.pool.query(
          "SELECT count(*)::integer AS count FROM inbox_messages WHERE message_id=$1",
          ["msg-" + wallet.id],
        )
      ).rows[0].count,
    ).toBe(1);

    expect(
      (
        await app.pool.query(
          "SELECT count(*)::integer AS count FROM outbox_messages WHERE aggregate_id=$1",
          [wallet.id],
        )
      ).rows[0].count,
    ).toBe(4);
    await reconcile(wallet.id);
  }, 15000);

  it("waits for an out-of-order REFUND and applies it once after the BET", async () => {
    const { wallet, request } = await setup();
    const refund = {
      ...request,
      externalTransactionId: "refund",
      kind: TransactionType.REFUND,
      referenceExternalTransactionId: request.externalTransactionId,
    };
    expect((await app.service.submit(refund, "refund:" + wallet.id, context)).status).toBe(
      TransactionStatus.PENDING_REFERENCE,
    );
    await app.service.submit(request, request.externalTransactionId, context);
    await app.service.retryPending();
    expect(await app.service.submit(refund, "refund:" + wallet.id, context)).toMatchObject({
      status: "PROCESSED",
      balance: { amount: "100.00" },
    });
    await reconcile(wallet.id);
  });

  it("records LOSS without changing balance or version and credits WIN", async () => {
    const { wallet, request } = await setup();
    const loss = {
      ...request,
      externalTransactionId: crypto.randomUUID(),
      kind: TransactionType.LOSS,
    };
    expect((await app.service.submit(loss, loss.externalTransactionId, context)).status).toBe(
      TransactionStatus.PROCESSED,
    );

    expect(
      (await app.pool.query("SELECT version FROM wallets WHERE id=$1", [wallet.id])).rows[0]
        .version,
    ).toBe(1);
    const win = {
      ...request,
      externalTransactionId: crypto.randomUUID(),
      kind: TransactionType.WIN,
    };
    expect((await app.service.submit(win, win.externalTransactionId, context)).balance.amount).toBe(
      "180.00",
    );

    expect(
      (
        await app.pool.query(
          "SELECT count(*)::integer AS entries FROM wallet_ledger_entries WHERE wallet_id=$1",
          [wallet.id],
        )
      ).rows[0].entries,
    ).toBe(2);
    await reconcile(wallet.id);
  });

  it("rejects a second REFUND and rejects reuse of the external ID with another key", async () => {
    const { wallet, request } = await setup();
    await app.service.submit(request, request.externalTransactionId, context);
    await expect(app.service.submit(request, crypto.randomUUID(), context)).rejects.toMatchObject({
      status: 409,
    });
    const refund = {
      ...request,
      externalTransactionId: crypto.randomUUID(),
      kind: TransactionType.REFUND,
      referenceExternalTransactionId: request.externalTransactionId,
    };
    expect((await app.service.submit(refund, refund.externalTransactionId, context)).status).toBe(
      TransactionStatus.PROCESSED,
    );
    const duplicate = { ...refund, externalTransactionId: crypto.randomUUID() };
    expect(
      (await app.service.submit(duplicate, duplicate.externalTransactionId, context)).failureCode,
    ).toBe("ALREADY_REVERSED");
    await reconcile(wallet.id);
  });

  it("uses a distinct failure code when rolling back a WIN would overdraw", async () => {
    const { wallet, request } = await setup();
    const win = {
      ...request,
      externalTransactionId: crypto.randomUUID(),
      kind: TransactionType.WIN,
    };
    await app.service.submit(win, win.externalTransactionId, context);
    const spend = { ...request, money: { amount: "170.00", currency: "BRL" } };
    await app.service.submit(spend, spend.externalTransactionId, context);
    const rollback = {
      ...win,
      externalTransactionId: crypto.randomUUID(),
      kind: TransactionType.ROLLBACK,
      referenceExternalTransactionId: win.externalTransactionId,
    };
    expect(
      await app.service.submit(rollback, rollback.externalTransactionId, context),
    ).toMatchObject({
      status: "REJECTED",
      failureCode: "REVERSAL_INSUFFICIENT_FUNDS",
      balance: { amount: "10.00" },
    });
    await reconcile(wallet.id);
  });

  it("rejects mismatched references, amounts, player and currency without moving money", async () => {
    const { wallet, request } = await setup();
    await app.service.submit(request, request.externalTransactionId, context);
    const variants = [
      { changes: { roundId: "different" }, code: "REFERENCE_MISMATCH" },
      { changes: { money: { amount: "1.00", currency: "BRL" } }, code: "REVERSAL_AMOUNT_MISMATCH" },
      { changes: { playerId: crypto.randomUUID() }, code: "PLAYER_MISMATCH" },
      { changes: { money: { amount: "80.00", currency: "USD" } }, code: "CURRENCY_MISMATCH" },
    ];
    for (const variant of variants) {
      const refund = {
        ...request,
        ...variant.changes,
        externalTransactionId: crypto.randomUUID(),
        kind: TransactionType.REFUND,
        referenceExternalTransactionId: request.externalTransactionId,
      };
      expect(
        (await app.service.submit(refund, refund.externalTransactionId, context)).failureCode,
      ).toBe(variant.code);
    }
    await reconcile(wallet.id);
  });

  it("expires an absent reference and emits a rejection event", async () => {
    const { wallet, request } = await setup();
    const refund = {
      ...request,
      externalTransactionId: crypto.randomUUID(),
      kind: TransactionType.REFUND,
      referenceExternalTransactionId: "missing",
    };
    const pending = await app.service.submit(refund, refund.externalTransactionId, context);
    await new FinanceService(app.db, 0).retryPending();
    const replay = await app.service.submit(refund, refund.externalTransactionId, context);
    expect(replay.failureCode).toBe("REFERENCE_EXPIRED");
    expect(
      (
        await app.pool.query(
          "SELECT count(*)::integer AS count FROM outbox_messages WHERE event_type='WagerTransactionRejected' AND payload->'data'->>'transactionId'=$1",
          [pending.transactionId],
        )
      ).rows[0].count,
    ).toBe(1);
    await reconcile(wallet.id);
  });

  it("rolls back all financial records and inbox/outbox when commit fails", async () => {
    const { wallet, request } = await setup();
    await app.pool.query(`CREATE FUNCTION simulate_commit_failure() RETURNS trigger AS $$ BEGIN
      RAISE EXCEPTION 'simulated commit failure'; END $$ LANGUAGE plpgsql;
      CREATE CONSTRAINT TRIGGER simulate_commit_failure AFTER INSERT ON inbox_messages
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION simulate_commit_failure()`);
    try {
      await expect(
        app.service.submit(request, request.externalTransactionId, context, {
          consumerName: "atomicity",
          messageId: "failure",
        }),
      ).rejects.toThrow("simulated commit failure");
    } finally {
      await app.pool.query(
        "DROP TRIGGER simulate_commit_failure ON inbox_messages; DROP FUNCTION simulate_commit_failure()",
      );
    }
    expect(
      (await app.pool.query("SELECT balance FROM wallets WHERE id=$1", [wallet.id])).rows[0]
        .balance,
    ).toBe("100.00");

    expect(
      (
        await app.pool.query("SELECT id FROM wager_transactions WHERE external_transaction_id=$1", [
          request.externalTransactionId,
        ])
      ).rows,
    ).toHaveLength(0);

    expect(
      (
        await app.pool.query(
          "SELECT message_id FROM inbox_messages WHERE consumer_name='atomicity'",
        )
      ).rows,
    ).toHaveLength(0);

    expect(
      (
        await app.pool.query(
          "SELECT count(*)::integer AS count FROM outbox_messages WHERE aggregate_id=$1",
          [wallet.id],
        )
      ).rows[0].count,
    ).toBe(2);
    await reconcile(wallet.id);
  });
});
