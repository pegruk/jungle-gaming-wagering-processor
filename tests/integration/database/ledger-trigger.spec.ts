import { beforeAll, describe, expect, it } from "bun:test";
import { Client } from "pg";

const DB_PORT = process.env.POSTGRES_PORT || "5433";
const CONNECTION_STRING =
  process.env.DATABASE_URL ||
  `postgresql://postgres:postgrespassword@localhost:${DB_PORT}/distributed_wagering_processor`;
describe("Database Ledger Immutability & Constraints", () => {
  const getDbClient = async () => {
    const client = new Client({
      connectionString: CONNECTION_STRING,
    });
    await client.connect();
    return client;
  };
  beforeAll(async () => {
    const client = await getDbClient();
    try {
      await client.query(
        "INSERT INTO wallets (id, player_id, currency, balance, version) VALUES ('w-test', 'p-test', 'BRL', 100.00, 1) ON CONFLICT (id) DO NOTHING;",
      );

      await client.query(
        "INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after) VALUES ('led-1', 'w-test', 'tx-seed-1', 'DEBIT', 10.00, 100.00, 90.00) ON CONFLICT (id) DO NOTHING;",
      );
    } finally {
      await client.end();
    }
  });

  it("should block any UPDATE statement on wallet_ledger_entries", async () => {
    const client = await getDbClient();
    try {
      await expect(
        client.query("UPDATE wallet_ledger_entries SET amount = 500.00 WHERE id = 'led-1'"),
      ).rejects.toThrow("wallet_ledger_entries are append-only");
    } finally {
      await client.end();
    }
  });

  it("should block any DELETE statement on wallet_ledger_entries", async () => {
    const client = await getDbClient();
    try {
      await expect(
        client.query("DELETE FROM wallet_ledger_entries WHERE id = 'led-1'"),
      ).rejects.toThrow("wallet_ledger_entries are append-only");
    } finally {
      await client.end();
    }
  });

  it("should enforce balance non-negative check constraint on wallets", async () => {
    const client = await getDbClient();
    try {
      await expect(
        client.query("UPDATE wallets SET balance = -10.00 WHERE id = 'w-test'"),
      ).rejects.toThrow("chk_wallet_balance_non_negative");
    } finally {
      await client.end();
    }
  });
});
