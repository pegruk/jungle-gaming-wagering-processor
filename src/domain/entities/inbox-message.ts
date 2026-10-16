export interface InboxState {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessage {
  private constructor(private readonly state: InboxState) {}
  static receive(props: Omit<InboxState, "receivedAt" | "processedAt">) {
    return new InboxMessage({ ...props, receivedAt: new Date() });
  }

  static rehydrate(state: InboxState) {
    return new InboxMessage({ ...state });
  }

  isProcessed(): boolean {
    return this.state.processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) throw new Error("Inbox already processed");
    this.state.processedAt = new Date(at);
  }

  toState(): InboxState {
    return { ...this.state };
  }
}
