import { describe, expect, it } from "bun:test";
import { Client } from "pg";
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";

const DB_PORT = process.env.POSTGRES_PORT || "5433";
const CONNECTION_STRING =
  process.env.DATABASE_URL ||
  `postgresql://postgres:postgrespassword@localhost:${DB_PORT}/distributed_wagering_processor`;
const SQS_ENDPOINT = process.env.AWS_ENDPOINT_URL || "http://127.0.0.1:4566";
describe("Transactional Outbox & SQS FIFO Pipeline", () => {
  it("should atomically persist outbox message in the same transaction as wallet balance", async () => {
    const client = new Client({
      connectionString: CONNECTION_STRING,
    });
    await client.connect();
    const walletId = "w-outbox-" + Date.now();
    const eventId = "evt-" + Date.now();
    await client.query("BEGIN;");
    await client.query(
      "INSERT INTO wallets (id, player_id, currency, balance, version) VALUES ($1, 'p-1', 'BRL', 50.00, 1);",
      [walletId],
    );

    await client.query(
      "INSERT INTO outbox_messages (id, event_type, payload, status) VALUES ($1, 'WalletBalanceChanged', $2, 'PENDING');",
      [eventId, JSON.stringify({ walletId, newBalance: "50.00" })],
    );
    await client.query("COMMIT;");
    const res = await client.query("SELECT status FROM outbox_messages WHERE id = $1;", [eventId]);
    await client.end();
    expect(res.rows[0].status).toBe("PENDING");
  });

  it("should publish and receive messages in SQS FIFO with deduplication and ordering", async () => {
    const sqs = new SQSClient({
      endpoint: SQS_ENDPOINT,
      region: "us-east-1",
      credentials: {
        accessKeyId: "test",
        secretAccessKey: "test",
      },
    });
    const queueUrl = `${SQS_ENDPOINT}/000000000000/wagering-events.fifo`;
    const messageGroupId = "wallet-group-" + Date.now();
    const deduplicationId = "dedup-" + Date.now();
    // 1. Envia mensagem para fila FIFO
    const sendResult = await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ event: "BetSettled", amount: "20.00" }),
        MessageGroupId: messageGroupId,
        MessageDeduplicationId: deduplicationId,
      }),
    );
    expect(sendResult.MessageId).toBeDefined();
    // 2. Recebe a mensagem do SQS
    const receiveResult = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
      }),
    );
    expect(receiveResult.Messages).toBeDefined();
    expect(receiveResult.Messages!.length).toBeGreaterThan(0);
    const receivedMessage = receiveResult.Messages![0];
    const parsedBody = JSON.parse(receivedMessage.Body!);
    expect(parsedBody.event).toBe("BetSettled");
    // 3. Deleta a mensagem (ACK pós-commit)
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receivedMessage.ReceiptHandle!,
      }),
    );
  });
});
