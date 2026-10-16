export interface EventContext { correlationId: string; causationId?: string; }
export interface EventProps<T> extends EventContext {
  eventId: string;
  aggregateId: string;
  occurredAt: Date;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  protected constructor(protected readonly props: EventProps<T>) {}

  toJSON() {
    return { eventId: this.props.eventId, eventType: this.eventType, version: this.version,
      aggregateId: this.props.aggregateId, correlationId: this.props.correlationId,
      ...(this.props.causationId ? { causationId: this.props.causationId } : {}),
      occurredAt: this.props.occurredAt.toISOString(), data: this.props.data };
  }
}

export class WagerTransactionProcessed extends IntegrationEvent<Record<string, unknown>> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;
  static from(props: EventProps<Record<string, unknown>>) { return new WagerTransactionProcessed(props); }
}

export class WagerTransactionRejected extends IntegrationEvent<Record<string, unknown>> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;
  static from(props: EventProps<Record<string, unknown>>) { return new WagerTransactionRejected(props); }
}

export class WagerTransactionPendingReference extends IntegrationEvent<Record<string, unknown>> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;
  static from(props: EventProps<Record<string, unknown>>) { return new WagerTransactionPendingReference(props); }
}

export class WalletBalanceChanged extends IntegrationEvent<Record<string, unknown>> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;
  static from(props: EventProps<Record<string, unknown>>) { return new WalletBalanceChanged(props); }
}
