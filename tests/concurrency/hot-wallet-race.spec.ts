import { describe, expect, it } from "bun:test";
import { Client } from "pg";

const DB_PORT = process.env.POSTGRES_PORT || "5433";
const CONNECTION_STRING =
  process.env.DATABASE_URL ||
  `postgresql://postgres:postgrespassword@localhost:${DB_PORT}/distributed_wagering_processor`;
describe("Concurrency: 50 Parallel Bets on Hot Wallet", () => {
  const executePessimisticBet = async (walletId: string, amount: string): Promise<boolean> => {
    const client = new Client({
      connectionString: CONNECTION_STRING,
    });
    await client.connect();
    try {
      await client.query("BEGIN;");
      // PESSIMISTIC LOCK: Bloqueia a linha da carteira com exclusividade
      const res = await client.query(
        "SELECT id, balance, version FROM wallets WHERE id = $1 FOR UPDATE;",
        [walletId],
      );
      const currentBalance = parseFloat(res.rows[0].balance);
      const betVal = parseFloat(amount);
      if (currentBalance < betVal) {
        await client.query("ROLLBACK;");
        return false; // Saldo insuficiente
      }
      const newBalance = (currentBalance - betVal).toFixed(2);
      await client.query("UPDATE wallets SET balance = $1, version = version + 1 WHERE id = $2;", [
        newBalance,
        walletId,
      ]);

      await client.query(
        "INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after) VALUES ($1, $2, $3, 'DEBIT', $4, $5, $6);",
        [
          crypto.randomUUID(),
          walletId,
          crypto.randomUUID(),
          amount,
          currentBalance.toFixed(2),
          newBalance,
        ],
      );
      await client.query("COMMIT;");
      return true;
    } catch (err) {
      await client.query("ROLLBACK;");
      throw err;
    } finally {
      await client.end();
    }
  };
  it("should process 50 concurrent bets: exactly 5 succeed, 45 fail, balance stops at 0.00", async () => {
    // 1. Prepara a carteira com R$ 100.00
    const setupClient = new Client({
      connectionString: CONNECTION_STRING,
    });
    await setupClient.connect();
    const testWalletId = "w-hot-" + Date.now();
    await setupClient.query(
      "INSERT INTO wallets (id, player_id, currency, balance, version) VALUES ($1, 'p-hot', 'BRL', 100.00, 1);",
      [testWalletId],
    );
    await setupClient.end();
    // 2. Dispara 50 apostas simultâneas de R$ 20.00 em paralelo real
    const betPromises = Array.from({ length: 50 }).map(() =>
      executePessimisticBet(testWalletId, "20.00"),
    );
    const results = await Promise.all(betPromises);
    const successfulBets = results.filter((r) => r === true).length;
    const failedBets = results.filter((r) => r === false).length;
    expect(successfulBets).toBe(5);
    expect(failedBets).toBe(45);
    // 3. Valida se o saldo no banco parou exatamente em 0.00
    const verifyClient = new Client({
      connectionString: CONNECTION_STRING,
    });
    await verifyClient.connect();
    const finalRes = await verifyClient.query(
      "SELECT balance, version FROM wallets WHERE id = $1;",
      [testWalletId],
    );
    const ledgerRes = await verifyClient.query(
      "SELECT COUNT(*) as total, SUM(amount) as debited FROM wallet_ledger_entries WHERE wallet_id = $1;",
      [testWalletId],
    );
    await verifyClient.end();
    expect(parseFloat(finalRes.rows[0].balance)).toBe(0.0);
    expect(parseInt(finalRes.rows[0].version)).toBe(6); // 1 inicial + 5 débitos
    expect(parseInt(ledgerRes.rows[0].total)).toBe(5);
    expect(parseFloat(ledgerRes.rows[0].debited)).toBe(100.0);
  });
});
