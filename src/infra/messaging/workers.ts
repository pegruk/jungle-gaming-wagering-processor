import { createHash } from "node:crypto";
import type { Message } from "@aws-sdk/client-sqs";
import { FinanceService, type TransactionResponse } from "../../application/finance.service";
import { ApplicationError, object } from "../../application/contracts";
import { OutboxMessage } from "../../domain/entities/outbox-message";
import { computeCanonicalSha256 } from "../../domain/utils/canonical-json";
import { SqsGateway } from "./sqs";
import {
  retriesTotal,
  dlqTotal,
  outboxLagSeconds,
  outboxLagTotal,
} from "../../application/metrics/wagering.metrics";
import { log } from "../observability/telemetry";

const INPUT = "wager-transactions.fifo";
const OUTPUT = "wager-events.fifo";

export interface WorkerHooks {
  afterFinancialCommit?(response: TransactionResponse): Promise<void>;
  afterPublishBeforeCommit?(): Promise<void>;
}

export class Workers {
  private stopping = false;
  private tasks: Promise<void>[] = [];

  constructor(
    readonly finance: FinanceService,
    readonly sqs: SqsGateway,
    private readonly hooks: WorkerHooks = {},
  ) {}

  start(): void {
    if (this.tasks.length) return;
    this.stopping = false;
    for (let worker = 0; worker < 4; worker++)
      this.tasks.push(this.loop(() => this.consumeOnce(), 20));
    this.tasks.push(this.loop(() => this.publishOnce(), 100));
    this.tasks.push(this.loop(() => this.publishOnce(), 100));
    this.tasks.push(this.loop(() => this.finance.retryPending(), 500));
    this.tasks.push(this.loop(() => this.consumeEventOnce(), 20));
  }

  private async loop(action: () => Promise<unknown>, pause: number): Promise<void> {
    while (!this.stopping) {
      let worked = false;
      try {
        worked = Boolean(await action());
      } catch {
        log("worker.dependency_failure", {});
      }
      if (!this.stopping && !worked) await Bun.sleep(pause);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled(this.tasks);
    this.tasks = [];
  }

  async publishOnce(): Promise<boolean> {
    const lag = await this.finance.db.session().query<{
      pending: number;
      seconds: string | null;
    }>(`SELECT count(*)::integer AS pending,
      extract(epoch from (now()-min(created_at)))::text AS seconds FROM outbox_messages WHERE published_at IS NULL`);
    outboxLagTotal.set(lag.rows[0]!.pending);
    outboxLagSeconds.set(Number(lag.rows[0]!.seconds || 0));
    return this.finance.db.transaction(async (sql) => {
      const found = await sql.query<{
        id: string;
        aggregate_id: string;
        event_type: string;
        payload: Record<string, unknown>;
        attempts: number;
        next_attempt_at: Date;
        created_at: Date;
      }>(`SELECT * FROM outbox_messages
          WHERE published_at IS NULL AND next_attempt_at<=now() ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1`);
      const row = found.rows[0];
      if (!row) return false;
      const message = OutboxMessage.rehydrate({
        id: row.id,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: row.payload,
        occurredAt: new Date(row.created_at),
        attempts: row.attempts,
        nextAttemptAt: new Date(row.next_attempt_at),
      });
      try {
        await this.sqs.send(OUTPUT, row.payload, row.aggregate_id, row.id);
      } catch {
        retriesTotal.inc({ component: "outbox" });
        message.scheduleRetry(new Date());
        const retry = message.toState();
        await sql.query(
          "UPDATE outbox_messages SET attempts=$2,next_attempt_at=$3,updated_at=now() WHERE id=$1",
          [row.id, retry.attempts, retry.nextAttemptAt],
        );
        return false;
      }
      // If the process dies here, the SQL lock is released and another publisher retries.
      await this.hooks.afterPublishBeforeCommit?.();
      message.markPublished(new Date());
      await sql.query(
        "UPDATE outbox_messages SET status='PUBLISHED',attempts=$2,published_at=$3,updated_at=now() WHERE id=$1",
        [row.id, message.toState().attempts, message.toState().publishedAt],
      );
      return true;
    });
  }

  async consumeOnce(): Promise<number> {
    const messages = await this.sqs.receive(INPUT);
    for (const message of messages) await this.handleInput(message);
    return messages.length;
  }

  private async handleInput(message: Message): Promise<void> {
    const heartbeat = setInterval(() => {
      void this.sqs.visibility(INPUT, message, 30).catch(() => {});
    }, 10000);
    try {
      let envelope: Record<string, unknown>;
      try {
        envelope = object(JSON.parse(message.Body || ""));
      } catch {
        throw new ApplicationError(400, "INVALID_MESSAGE");
      }
      if (
        envelope.type !== "WagerTransactionRequested" ||
        typeof envelope.messageId !== "string" ||
        !envelope.messageId.trim() ||
        envelope.messageId.length > 128 ||
        typeof envelope.occurredAt !== "string" ||
        !Number.isFinite(Date.parse(envelope.occurredAt))
      )
        throw new ApplicationError(400, "INVALID_MESSAGE");
      const { idempotencyKey, ...request } = object(envelope.data);
      const response = await this.finance.submit(
        request,
        idempotencyKey,
        {
          correlationId:
            typeof envelope.correlationId === "string" && envelope.correlationId.length <= 128
              ? envelope.correlationId
              : envelope.messageId,
          causationId: envelope.messageId,
          ...(typeof envelope.traceparent === "string"
            ? { traceparent: envelope.traceparent }
            : {}),
        },
        { consumerName: "wagering-processor", messageId: envelope.messageId },
      );
      await this.hooks.afterFinancialCommit?.(response);
      await this.sqs.ack(INPUT, message);
    } catch (error) {
      if (error instanceof ApplicationError && error.status === 404)
        await this.sqs.ack(INPUT, message);
      else if (error instanceof ApplicationError && error.status < 500)
        await this.deadLetter(INPUT, message, error.code);
      else await this.retry(INPUT, message);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async retry(queue: string, message: Message): Promise<void> {
    retriesTotal.inc({ component: "sqs" });
    const count = Number(message.Attributes?.ApproximateReceiveCount || "1");
    if (count >= 3) await this.deadLetter(queue, message, "ATTEMPTS_EXHAUSTED");
    else await this.sqs.visibility(queue, message, Math.min(30, 2 ** count));
  }

  private async deadLetter(queue: string, message: Message, code: string): Promise<void> {
    const id = createHash("sha256")
      .update(message.MessageId || message.Body || "")
      .digest("hex");
    let original: unknown;
    try {
      original = JSON.parse(message.Body || "null");
    } catch {
      original = { raw: message.Body };
    }
    await this.sqs.send(
      queue.replace(".fifo", "-dlq.fifo"),
      { failureCode: code, original },
      "dead-letters",
      id,
    );
    dlqTotal.inc();
    log("sqs.dead_letter", { messageId: message.MessageId, failureCode: code });
    await this.sqs.ack(queue, message);
  }

  async consumeEventOnce(): Promise<number> {
    const messages = await this.sqs.receive(OUTPUT);
    for (const message of messages) {
      try {
        let envelope: Record<string, unknown>;
        try {
          envelope = object(JSON.parse(message.Body || ""));
        } catch {
          throw new ApplicationError(400, "INVALID_EVENT");
        }
        if (
          typeof envelope.eventId !== "string" ||
          envelope.eventId.length > 64 ||
          !envelope.eventId ||
          envelope.version !== 1 ||
          ![
            "WalletBalanceChanged",
            "WagerTransactionProcessed",
            "WagerTransactionRejected",
            "WagerTransactionPendingReference",
          ].includes(String(envelope.eventType))
        )
          throw new ApplicationError(400, "INVALID_EVENT");
        const hash = computeCanonicalSha256(envelope);
        await this.finance.db.transaction(async (sql) => {
          await sql.query(
            "INSERT INTO event_receipts (consumer_name,event_id,payload_hash) VALUES ('integration-audit',$1,$2) ON CONFLICT DO NOTHING",
            [envelope.eventId, hash],
          );
          const saved = await sql.query<{ payload_hash: string }>(
            "SELECT payload_hash FROM event_receipts WHERE consumer_name='integration-audit' AND event_id=$1",
            [envelope.eventId],
          );
          if (saved.rows[0]?.payload_hash !== hash)
            throw new ApplicationError(409, "EVENT_PAYLOAD_CONFLICT");
        });
        await this.sqs.ack(OUTPUT, message);
      } catch (error) {
        if (error instanceof ApplicationError) await this.deadLetter(OUTPUT, message, error.code);
        else await this.retry(OUTPUT, message);
      }
    }
    return messages.length;
  }
}
