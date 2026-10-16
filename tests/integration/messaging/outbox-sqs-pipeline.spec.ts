import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createTestApplication } from "../../helpers/application";
import { createTestQueues, eventually } from "../../helpers/sqs";
import { Workers } from "../../../src/infra/messaging/workers";
import { SqsGateway } from "../../../src/infra/messaging/sqs";

describe("Real outbox publishers, SQS inbox, retry and DLQ", () => {
  let app: Awaited<ReturnType<typeof createTestApplication>>;
  let queues: Awaited<ReturnType<typeof createTestQueues>>;
  let workers: Workers;
  const context = { correlationId: "sqs-tests" };

  beforeAll(async () => {
    app = await createTestApplication();
    queues = await createTestQueues();
    workers = new Workers(app.service, queues.gateway);
  });

  afterAll(async () => {
    await queues?.close();
    await app?.close();
  });

  afterEach(async () => {
    await app.verify();
  });

  async function envelope() {
    const wallet = await app.service.createWallet(
      { playerId: crypto.randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" } },
      context,
    );
    const id = crypto.randomUUID();
    return {
      wallet,
      message: {
        messageId: id,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId: "sqs",
          externalTransactionId: id,
          idempotencyKey: id,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "round",
          gameId: "game",
          kind: "BET",
          money: { amount: "10.00", currency: "BRL" },
        },
      },
    };
  }

  it("commits once when a message is redelivered after commit before ack", async () => {
    const { wallet, message } = await envelope();
    await queues.gateway.send("wager-transactions.fifo", message, wallet.id, message.messageId);
    const crashing = new Workers(app.service, queues.gateway, {
      async afterFinancialCommit() {
        throw new Error("crash before ack");
      },
    });
    expect(await crashing.consumeOnce()).toBe(1);
    await eventually(async () => (await workers.consumeOnce()) === 1);
    expect(
      (await app.pool.query("SELECT balance FROM wallets WHERE id=$1", [wallet.id])).rows[0]
        .balance,
    ).toBe("90.00");

    expect(
      (
        await app.pool.query(
          "SELECT count(*)::integer AS count FROM inbox_messages WHERE message_id=$1",
          [message.messageId],
        )
      ).rows[0].count,
    ).toBe(1);
  }, 15000);

  it("publishes concurrently and safely consumes a duplicate integration event", async () => {
    const publisher2 = new Workers(app.service, queues.gateway);
    await eventually(async () => {
      await Promise.all([workers.publishOnce(), publisher2.publishOnce()]);
      return (
        (
          await app.pool.query(
            "SELECT count(*)::integer AS count FROM outbox_messages WHERE published_at IS NULL",
          )
        ).rows[0].count === 0
      );
    });
    const events = (
      await app.pool.query("SELECT id,payload,aggregate_id FROM outbox_messages ORDER BY id")
    ).rows;
    await eventually(async () => {
      await workers.consumeEventOnce();
      return (
        (await app.pool.query("SELECT count(*)::integer AS count FROM event_receipts")).rows[0]
          .count === events.length
      );
    });
    const event = events[0];
    await queues.gateway.send(
      "wager-events.fifo",
      event.payload,
      event.aggregate_id,
      crypto.randomUUID(),
    );
    await workers.consumeEventOnce();
    expect(
      (
        await app.pool.query(
          "SELECT count(*)::integer AS count FROM event_receipts WHERE event_id=$1",
          [event.id],
        )
      ).rows[0].count,
    ).toBe(1);
  }, 15000);

  it("reschedules an unavailable SQS publish and recovers with another publisher", async () => {
    await envelope();
    const unavailable = new SqsGateway("http://127.0.0.1:1");
    try {
      expect(await new Workers(app.service, unavailable).publishOnce()).toBe(false);
    } finally {
      unavailable.close();
    }
    expect(
      (
        await app.pool.query(
          "SELECT count(*)::integer AS count FROM outbox_messages WHERE attempts>0 AND published_at IS NULL AND next_attempt_at>now()",
        )
      ).rows[0].count,
    ).toBeGreaterThan(0);

    await app.pool.query(
      "UPDATE outbox_messages SET next_attempt_at=now() WHERE published_at IS NULL",
    );

    await eventually(async () => {
      await workers.publishOnce();
      return (
        (
          await app.pool.query(
            "SELECT count(*)::integer AS count FROM outbox_messages WHERE published_at IS NULL",
          )
        ).rows[0].count === 0
      );
    });
  });

  it("routes malformed input to the real DLQ", async () => {
    await queues.gateway.send(
      "wager-transactions.fifo",
      { malformed: true },
      "bad",
      crypto.randomUUID(),
    );
    expect(await workers.consumeOnce()).toBe(1);
    const messages = await queues.gateway.receive("wager-transactions-dlq.fifo");
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]!.Body!).failureCode).toBe("INVALID_MESSAGE");
    await queues.gateway.ack("wager-transactions-dlq.fifo", messages[0]!);
  });

  it("limits transient failures to three receives before the DLQ without a debit", async () => {
    const { wallet, message } = await envelope();
    await app.pool
      .query(`CREATE FUNCTION retry_test_failure() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'temporary failure'; END $$ LANGUAGE plpgsql;
      CREATE CONSTRAINT TRIGGER retry_test_failure AFTER INSERT ON inbox_messages DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION retry_test_failure()`);
    try {
      await queues.gateway.send("wager-transactions.fifo", message, wallet.id, message.messageId);
      for (let attempt = 0; attempt < 3; attempt++)
        await eventually(async () => (await workers.consumeOnce()) === 1);
      const dead = await queues.gateway.receive("wager-transactions-dlq.fifo");
      expect(dead).toHaveLength(1);
      expect(JSON.parse(dead[0]!.Body!).failureCode).toBe("ATTEMPTS_EXHAUSTED");
      await queues.gateway.ack("wager-transactions-dlq.fifo", dead[0]!);
      expect(
        (await app.pool.query("SELECT balance FROM wallets WHERE id=$1", [wallet.id])).rows[0]
          .balance,
      ).toBe("100.00");
    } finally {
      await app.pool.query(
        "DROP TRIGGER retry_test_failure ON inbox_messages; DROP FUNCTION retry_test_failure()",
      );
    }
  }, 20000);

  it("rolls back a publication marker if the process fails after sending", async () => {
    await envelope();
    const crashing = new Workers(app.service, queues.gateway, {
      async afterPublishBeforeCommit() {
        throw new Error("crash after send");
      },
    });
    await expect(crashing.publishOnce()).rejects.toThrow("crash after send");
    expect(
      (
        await app.pool.query(
          "SELECT count(*)::integer AS count FROM outbox_messages WHERE published_at IS NULL",
        )
      ).rows[0].count,
    ).toBeGreaterThan(0);
    await workers.publishOnce();
  });

  it("marks only confirmed entries from a partially successful batch", async () => {
    await envelope();
    class PartialGateway extends SqsGateway {
      override async sendBatch(
        name: string,
        messages: { id: string; group: string; body: unknown }[],
      ) {
        // Keep the transport real; only one entry gets an affirmative SQS confirmation.
        return super.sendBatch(name, messages.slice(0, 1));
      }
    }
    const partial = new PartialGateway();
    for (const [name, url] of queues.gateway.urls) partial.urls.set(name, url);
    const before = (
      await app.pool.query(
        "SELECT count(*)::integer AS count FROM outbox_messages WHERE published_at IS NOT NULL",
      )
    ).rows[0].count;
    try {
      await new Workers(app.service, partial).publishOnce();
    } finally {
      partial.close();
    }
    expect(
      (
        await app.pool.query(
          "SELECT count(*)::integer AS count FROM outbox_messages WHERE published_at IS NOT NULL",
        )
      ).rows[0].count,
    ).toBe(before + 1);

    expect(
      (
        await app.pool.query(
          "SELECT count(*)::integer AS count FROM outbox_messages WHERE published_at IS NULL AND attempts>0 AND next_attempt_at>now()",
        )
      ).rows[0].count,
    ).toBeGreaterThan(0);

    await app.pool.query(
      "UPDATE outbox_messages SET next_attempt_at=now() WHERE published_at IS NULL",
    );
    await workers.publishOnce();
    expect(
      (await app.pool.query("SELECT id FROM outbox_messages WHERE published_at IS NULL")).rows,
    ).toHaveLength(0);
  });
});
