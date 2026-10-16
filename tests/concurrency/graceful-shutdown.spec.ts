import { describe, expect, it } from "bun:test";
import { createTestApplication } from "../helpers/application";
import { createTestQueues } from "../helpers/sqs";
import { firstLine } from "../helpers/process";

describe("SIGTERM during message processing", () => {
  it("drains and acknowledges the committed message before closing dependencies", async () => {
    const app = await createTestApplication();
    const queues = await createTestQueues();
    let child: Bun.Subprocess<"ignore", "pipe", "inherit"> | undefined;
    try {
      const wallet = await app.service.createWallet(
        { playerId: crypto.randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" } },
        { correlationId: "shutdown" },
      );
      const id = crypto.randomUUID();
      await queues.gateway.send(
        "wager-transactions.fifo",
        {
          messageId: id,
          type: "WagerTransactionRequested",
          occurredAt: new Date().toISOString(),
          data: {
            providerId: "shutdown",
            externalTransactionId: id,
            idempotencyKey: id,
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: "round",
            gameId: "game",
            kind: "BET",
            money: { amount: "10.00", currency: "BRL" },
          },
        },
        wallet.id,
        id,
      );

      child = Bun.spawn([process.execPath, "tests/fixtures/graceful-worker.ts"], {
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
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      expect(await queues.gateway.receive("wager-transactions.fifo")).toHaveLength(0);
      expect(
        (await app.pool.query("SELECT balance FROM wallets WHERE id=$1", [wallet.id])).rows[0]
          .balance,
      ).toBe("90.00");

      expect(
        (
          await app.pool.query(
            "SELECT count(*)::integer AS count FROM inbox_messages WHERE message_id=$1",
            [id],
          )
        ).rows[0].count,
      ).toBe(1);
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
