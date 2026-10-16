import type { IntegrationEvent } from "../events/integration-event";

export interface OutboxState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(private readonly state: OutboxState) {}
  static enqueue(event: IntegrationEvent<Record<string, unknown>>): OutboxMessage {
    const payload = event.toJSON();
    return new OutboxMessage({
      id: payload.eventId,
      aggregateId: payload.aggregateId,
      eventType: payload.eventType,
      payload,
      occurredAt: new Date(payload.occurredAt),
      attempts: 0,
    });
  }

  static rehydrate(state: OutboxState) {
    return new OutboxMessage({ ...state });
  }

  isPending(): boolean {
    return !this.state.publishedAt;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (!this.state.nextAttemptAt || this.state.nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) throw new Error("Outbox already published");
    this.state.publishedAt = new Date(at);
    this.state.attempts++;
  }

  scheduleRetry(now: Date): void {
    if (!this.isPending()) throw new Error("Published outbox cannot retry");
    this.state.attempts++;
    this.state.nextAttemptAt = new Date(
      now.getTime() + Math.min(300000, 1000 * 2 ** Math.min(this.state.attempts - 1, 10)),
    );
  }

  toState(): OutboxState {
    return { ...this.state };
  }
}
