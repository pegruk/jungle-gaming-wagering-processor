import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { migrate } from "../../../scripts/migrate";
import { createTestDatabase, withClient, type TestDatabase } from "../../helpers/database";

describe("Financial constraints and reversible migrations", () => {
  let db: TestDatabase;

  beforeAll(async () => { db = await createTestDatabase(); });
  afterAll(async () => { await db?.close(); });

  it("rejects two wallets for the same player and currency", async () => {
    const id = crypto.randomUUID();
    await db.pool.query("INSERT INTO wallets (id, player_id, currency) VALUES ($1, $1, 'BRL')", [id]);
    await expect(db.pool.query("INSERT INTO wallets (id, player_id, currency) VALUES ($1, $2, 'BRL')", [crypto.randomUUID(), id]))
      .rejects.toMatchObject({ code: "23505", constraint: "uq_wallet_player_currency" });
    await db.pool.query("INSERT INTO wallets (id, player_id, currency) VALUES ($1, $2, 'USD')", [crypto.randomUUID(), id]);
  });

  it("rejects a second ledger entry for the same wallet and transaction", async () => {
    const id = crypto.randomUUID();
    await db.pool.query("INSERT INTO wallets (id, player_id, currency, balance) VALUES ($1, $1, 'BRL', '1.00')", [id]);
    const insert = (entry: string) => db.pool.query(`INSERT INTO wallet_ledger_entries
      (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after)
      VALUES ($1, $2, $2, 'CREDIT', '1.00', '0.00', '1.00')`, [entry, id]);
    await insert(crypto.randomUUID());
    await expect(insert(crypto.randomUUID())).rejects.toMatchObject({ code: "23505", constraint: "uq_ledger_wallet_transaction" });
  });

  it("rejects arithmetically correct entries that have negative balances", async () => {
    const id = crypto.randomUUID();
    await db.pool.query("INSERT INTO wallets (id, player_id, currency) VALUES ($1, $1, 'BRL')", [id]);
    await expect(db.pool.query(`INSERT INTO wallet_ledger_entries
      (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after)
      VALUES ($1, $1, $1, 'DEBIT', '2.00', '1.00', '-1.00')`, [id]))
      .rejects.toMatchObject({ code: "23514", constraint: "chk_ledger_balances_non_negative" });
  });

  it("rejects inconsistent ledger arithmetic and invalid wallet versions", async () => {
    const id = crypto.randomUUID();
    await db.pool.query("INSERT INTO wallets (id, player_id, currency) VALUES ($1, $1, 'BRL')", [id]);
    await expect(db.pool.query(`INSERT INTO wallet_ledger_entries
      (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after)
      VALUES ($1, $1, $1, 'CREDIT', '1.00', '0.00', '2.00')`, [id]))
      .rejects.toMatchObject({ code: "23514", constraint: "chk_ledger_balance_math" });
    await expect(db.pool.query("UPDATE wallets SET version = 0 WHERE id = $1", [id]))
      .rejects.toMatchObject({ code: "23514", constraint: "chk_wallet_version_positive" });
  });

  it("applies idempotently and rolls every migration down and up in an isolated schema", async () => {
    const migrationDb = await createTestDatabase();
    try {
      await withClient(migrationDb.pool, (client) => migrate(client));
      expect((await migrationDb.pool.query("SELECT COUNT(*)::integer AS total FROM schema_migrations")).rows[0].total).toBe(4);
      for (let step = 0; step < 4; step++) {
        await withClient(migrationDb.pool, (client) => migrate(client, "down"));
      }
      expect((await migrationDb.pool.query("SELECT to_regclass(current_schema() || '.wallets') AS table_name")).rows[0].table_name).toBeNull();
      await withClient(migrationDb.pool, (client) => migrate(client));
      expect((await migrationDb.pool.query("SELECT COUNT(*)::integer AS total FROM schema_migrations")).rows[0].total).toBe(4);
    } finally {
      await migrationDb.close();
    }
  });
});
