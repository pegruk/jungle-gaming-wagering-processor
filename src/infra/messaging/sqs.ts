import {
  SQSClient,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  SendMessageBatchCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  type Message,
} from "@aws-sdk/client-sqs";

export class SqsGateway {
  readonly client: SQSClient;
  readonly urls = new Map<string, string>();

  constructor(
    private readonly endpoint = process.env.AWS_ENDPOINT_URL || "http://localhost:4566",
    readonly visibilityTimeout = 30,
  ) {
    this.client = new SQSClient({
      endpoint: this.endpoint,
      region: process.env.AWS_REGION || "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "test",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test",
      },
      maxAttempts: 2,
      requestHandler: { requestTimeout: 15000, connectionTimeout: 3000 },
    });
  }

  async url(name: string): Promise<string> {
    if (!this.urls.has(name)) {
      const result = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
      if (!result.QueueUrl) throw new Error("Queue URL missing");
      const queue = new URL(result.QueueUrl);
      const endpoint = new URL(this.endpoint);
      queue.host = endpoint.host;
      queue.protocol = endpoint.protocol;
      this.urls.set(name, queue.toString());
    }
    return this.urls.get(name)!;
  }

  async ready(): Promise<boolean> {
    try {
      for (const name of ["wager-transactions.fifo", "wager-events.fifo"]) {
        await this.client.send(
          new GetQueueAttributesCommand({
            QueueUrl: await this.url(name),
            AttributeNames: ["QueueArn"],
          }),
        );
      }
      return true;
    } catch {
      return false;
    }
  }

  async send(name: string, body: unknown, group: string, deduplicationId: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.url(name),
        MessageBody: JSON.stringify(body),
        MessageGroupId: group,
        MessageDeduplicationId: deduplicationId,
      }),
    );
  }

  async sendBatch(
    name: string,
    messages: { id: string; group: string; body: unknown }[],
  ): Promise<Set<string>> {
    const result = await this.client.send(
      new SendMessageBatchCommand({
        QueueUrl: await this.url(name),
        Entries: messages.map((message) => ({
          Id: message.id,
          MessageBody: JSON.stringify(message.body),
          MessageGroupId: message.group,
          MessageDeduplicationId: message.id,
        })),
      }),
    );
    return new Set((result.Successful ?? []).map((entry) => entry.Id!));
  }

  async receive(name: string, wait = 1, max = 1): Promise<Message[]> {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.url(name),
        MaxNumberOfMessages: max,
        WaitTimeSeconds: wait,
        VisibilityTimeout: this.visibilityTimeout,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );
    return result.Messages ?? [];
  }

  async ack(name: string, message: Message): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: await this.url(name),
        ReceiptHandle: message.ReceiptHandle!,
      }),
    );
  }

  async visibility(name: string, message: Message, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.url(name),
        ReceiptHandle: message.ReceiptHandle!,
        VisibilityTimeout: seconds,
      }),
    );
  }

  close(): void {
    this.client.destroy();
  }
}
