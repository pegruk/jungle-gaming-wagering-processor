import { describe, expect, it } from "bun:test";
import { createTestApplication } from "../helpers/application";
import { createTestQueues, eventually } from "../helpers/sqs";
import { firstLine } from "../helpers/process";
import { Workers } from "../../src/infra/messaging/workers";

describe("Process death after commit before SQS ack", () => {
  it("survives SIGKILL and another worker safely processes the redelivery", async () => {
    const app = await createTestApplication();
    const queues = await createTestQueues();
    let child: Bun.Subprocess<"ignore", "pipe", "inherit"> | undefined;
    try {
      const wallet = await app.service.createWallet(
        { playerId: crypto.randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" } },
        { correlationId: "crash" },
      );
      const id = crypto.randomUUID();
      await queues.gateway.send(
        "wager-transactions.fifo",
        {
          messageId: id,
          type: "WagerTransactionRequested",
          occurredAt: new Date().toISOString(),
          data: {
            providerId: "crash",
            externalTransactionId: id,
            idempotencyKey: id,
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: "round",
            gameId: "game",
            kind: "BET",
            money: { amount: "80.00", currency: "BRL" },
          },
        },
        wallet.id,
        id,
      );

      child = Bun.spawn([process.execPath, "tests/fixtures/commit-before-ack.ts"], {
        stdout: "pipe",
        stderr: "inherit",
        env: {
          ...process.env,
          LOG_LEVEL: "silent",
          DATABASE_URL: app.connectionString,
          DATABASE_SCHEMA: app.schema,
          TEST_QUEUE_URLS: JSON.stringify(Object.fromEntries(queues.gateway.urls)),
        },
      });
      expect(await firstLine(child.stdout)).toBe("COMMITTED");
      child.kill("SIGKILL");
      await child.exited;
      const replacement = new Workers(app.service, queues.gateway);
      await eventually(async () => (await replacement.consumeOnce()) === 1);
      const result = await app.pool.query(
        `SELECT w.balance,coalesce(sum(CASE WHEN l.direction='CREDIT' THEN l.amount ELSE -l.amount END),0)::numeric(16,2)::text AS calculated
        FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id=w.id WHERE w.id=$1 GROUP BY w.id`,
        [wallet.id],
      );
      expect(result.rows[0]).toEqual({ balance: "20.00", calculated: "20.00" });
      expect(
        (
          await app.pool.query(
            "SELECT count(*)::integer AS count FROM inbox_messages WHERE message_id=$1",
            [id],
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
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      await queues.close();
      await app.close();
    }
  }, 20000);
});
