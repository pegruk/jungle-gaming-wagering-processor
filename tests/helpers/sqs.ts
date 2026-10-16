import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  DeleteQueueCommand,
} from "@aws-sdk/client-sqs";
import { SqsGateway } from "../../src/infra/messaging/sqs";

export async function createTestQueues() {
  const gateway = new SqsGateway(undefined, 2);
  const prefix = `test-${crypto.randomUUID().slice(0, 16)}`;
  for (const name of ["wager-transactions", "wager-events"]) {
    const deadLetter = await gateway.client.send(
      new CreateQueueCommand({
        QueueName: `${prefix}-${name}-dlq.fifo`,
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
      }),
    );
    gateway.urls.set(`${name}-dlq.fifo`, deadLetter.QueueUrl!);
    const arn = await gateway.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: deadLetter.QueueUrl,
        AttributeNames: ["QueueArn"],
      }),
    );
    const queue = await gateway.client.send(
      new CreateQueueCommand({
        QueueName: `${prefix}-${name}.fifo`,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "false",
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: arn.Attributes!.QueueArn,
            maxReceiveCount: "3",
          }),
        },
      }),
    );
    gateway.urls.set(`${name}.fifo`, queue.QueueUrl!);
  }
  return {
    gateway,
    async close() {
      for (const url of gateway.urls.values())
        await gateway.client.send(new DeleteQueueCommand({ QueueUrl: url }));
      gateway.close();
    },
  };
}

export async function eventually(check: () => Promise<boolean>, timeout = 10000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error("Condition did not become true before timeout");
}
