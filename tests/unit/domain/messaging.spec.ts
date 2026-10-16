import { describe, expect, it } from "bun:test";
import { InboxMessage } from "../../../src/domain/entities/inbox-message";
import { OutboxMessage } from "../../../src/domain/entities/outbox-message";
import { WagerTransactionProcessed } from "../../../src/domain/events/integration-event";

describe("Inbox and outbox lifecycle", () => {
  it("marks an inbox receipt once", () => {
    const message = InboxMessage.receive({
      consumerName: "test",
      messageId: "message",
      payloadHash: "hash",
    });
    expect(message.isProcessed()).toBe(false);
    message.markProcessed(new Date());
    expect(message.isProcessed()).toBe(true);
    expect(() => message.markProcessed(new Date())).toThrow();
  });

  it("retries with exponential backoff and caps it, then stops after publication", () => {
    const now = new Date();
    const message = OutboxMessage.enqueue(
      WagerTransactionProcessed.from({
        eventId: "event",
        aggregateId: "wallet",
        correlationId: "request",
        occurredAt: now,
        data: {},
      }),
    );
    message.scheduleRetry(now);
    expect(message.toState().nextAttemptAt!.getTime() - now.getTime()).toBe(1000);
    message.scheduleRetry(now);
    expect(message.toState().nextAttemptAt!.getTime() - now.getTime()).toBe(2000);
    for (let attempt = 0; attempt < 20; attempt++) message.scheduleRetry(now);
    expect(message.toState().nextAttemptAt!.getTime() - now.getTime()).toBe(300000);
    expect(message.isDue(now)).toBe(false);
    message.markPublished(now);
    expect(message.isPending()).toBe(false);
    expect(() => message.scheduleRetry(now)).toThrow();
  });
});
