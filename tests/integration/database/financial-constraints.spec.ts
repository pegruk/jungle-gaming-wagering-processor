import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { migrate } from "../../../scripts/migrate";
import { createTestDatabase, withClient, type TestDatabase } from "../../helpers/database";
import { createTestApplication } from "../../helpers/application";

describe("Financial constraints and reversible migrations", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  it("rejects two wallets for the same player and currency", async () => {
    const id = crypto.randomUUID();
    await db.pool.query("INSERT INTO wallets (id, player_id, currency) VALUES ($1, $1, 'BRL')", [
      id,
    ]);

    await expect(
      db.pool.query("INSERT INTO wallets (id, player_id, currency) VALUES ($1, $2, 'BRL')", [
        crypto.randomUUID(),
        id,
      ]),
    ).rejects.toMatchObject({ code: "23505", constraint: "uq_wallet_player_currency" });

    await db.pool.query("INSERT INTO wallets (id, player_id, currency) VALUES ($1, $2, 'USD')", [
      crypto.randomUUID(),
      id,
    ]);
  });

  it("rejects a second ledger entry for the same wallet and transaction", async () => {
    const app = await createTestApplication();
    try {
      const wallet = await app.service.createWallet(
        { playerId: crypto.randomUUID(), initialBalance: { amount: "1.00", currency: "BRL" } },
        { correlationId: "constraints" },
      );
      const row = (
        await app.pool.query(
          "SELECT transaction_id FROM wallet_ledger_entries WHERE wallet_id=$1",
          [wallet.id],
        )
      ).rows[0];
      await expect(
        app.pool.query(
          `INSERT INTO wallet_ledger_entries
        (id,wallet_id,transaction_id,direction,amount,balance_before,balance_after,currency,wallet_version)
        VALUES ($1,$2,$3,'CREDIT','1.00','0.00','1.00','BRL',2)`,
          [crypto.randomUUID(), wallet.id, row.transaction_id],
        ),
      ).rejects.toMatchObject({ code: "23505", constraint: "uq_ledger_wallet_transaction" });
    } finally {
      await app.close();
    }
  });

  it("rejects arithmetically correct entries that have negative balances", async () => {
    const id = crypto.randomUUID();
    await db.pool.query("INSERT INTO wallets (id, player_id, currency) VALUES ($1, $1, 'BRL')", [
      id,
    ]);

    await expect(
      db.pool.query(
        `INSERT INTO wallet_ledger_entries
      (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after,currency,wallet_version)
      VALUES ($1, $1, $1, 'DEBIT', '2.00', '1.00', '-1.00','BRL',2)`,
        [id],
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "chk_ledger_balances_non_negative" });
  });

  it("rejects inconsistent ledger arithmetic and invalid wallet versions", async () => {
    const id = crypto.randomUUID();
    await db.pool.query("INSERT INTO wallets (id, player_id, currency) VALUES ($1, $1, 'BRL')", [
      id,
    ]);

    await expect(
      db.pool.query(
        `INSERT INTO wallet_ledger_entries
      (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after,currency,wallet_version)
      VALUES ($1, $1, $1, 'CREDIT', '1.00', '0.00', '2.00','BRL',2)`,
        [id],
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "chk_ledger_balance_math" });

    await expect(
      db.pool.query("UPDATE wallets SET version = 0 WHERE id = $1", [id]),
    ).rejects.toMatchObject({ code: "23514", constraint: "chk_wallet_version_positive" });
  });

  it("applies idempotently and rolls every migration down and up in an isolated schema", async () => {
    const migrationDb = await createTestDatabase();
    try {
      await withClient(migrationDb.pool, (client) => migrate(client));
      const total = [...new Bun.Glob("[0-9]*.sql").scanSync("scripts/migrations")].length;
      expect(
        (await migrationDb.pool.query("SELECT COUNT(*)::integer AS total FROM schema_migrations"))
          .rows[0].total,
      ).toBe(total);
      for (let step = 0; step < total; step++) {
        await withClient(migrationDb.pool, (client) => migrate(client, "down"));
      }
      expect(
        (
          await migrationDb.pool.query(
            "SELECT to_regclass(current_schema() || '.wallets') AS table_name",
          )
        ).rows[0].table_name,
      ).toBeNull();
      await withClient(migrationDb.pool, (client) => migrate(client));
      expect(
        (await migrationDb.pool.query("SELECT COUNT(*)::integer AS total FROM schema_migrations"))
          .rows[0].total,
      ).toBe(total);
    } finally {
      await migrationDb.close();
    }
  });
});
