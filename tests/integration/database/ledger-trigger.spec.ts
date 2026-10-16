import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApplication } from "../../helpers/application";

describe("Ledger immutability and accounting integrity", () => {
  let app: Awaited<ReturnType<typeof createTestApplication>>;
  let walletId: string;
  beforeAll(async () => {
    app = await createTestApplication();
    walletId = (
      await app.service.createWallet(
        { playerId: crypto.randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" } },
        { correlationId: "ledger" },
      )
    ).id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("blocks UPDATE and DELETE on ledger and journal", async () => {
    await expect(
      app.pool.query("UPDATE wallet_ledger_entries SET amount='500.00' WHERE wallet_id=$1", [
        walletId,
      ]),
    ).rejects.toThrow("append-only");
    await expect(app.pool.query("TRUNCATE wallet_ledger_entries CASCADE")).rejects.toThrow("append-only");

    await expect(
      app.pool.query("DELETE FROM wallet_ledger_entries WHERE wallet_id=$1", [walletId]),
    ).rejects.toThrow("append-only");

    await expect(
      app.pool.query("DELETE FROM journal_postings WHERE account_id=$1", [`wallet:${walletId}`]),
    ).rejects.toThrow("append-only");
  });

  it("rejects balance updates without matching ledger and rejects negative balance", async () => {
    await expect(
      app.pool.query("UPDATE wallets SET balance='200.00' WHERE id=$1", [walletId]),
    ).rejects.toThrow("differs from ledger");

    await expect(
      app.pool.query("UPDATE wallets SET balance='-1.00' WHERE id=$1", [walletId]),
    ).rejects.toThrow("chk_wallet_balance_non_negative");
  });

  it("keeps every journal balanced and every terminal transaction immutable", async () => {
    const journal = await app.pool.query(
      "SELECT sum(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END)::text AS net,count(*)::integer AS entries FROM journal_postings",
    );
    expect(journal.rows[0]).toEqual({ net: "0.00", entries: 2 });
    await expect(
      app.pool.query("UPDATE wager_transactions SET status='PENDING' WHERE wallet_id=$1", [
        walletId,
      ]),
    ).rejects.toThrow("terminal wager is immutable");
  });
});
