import type { Client } from "pg";
import { canonicalize, computeCanonicalSha256 } from "../utils/canonical-json";

export interface OperationResponse {
  status: number;
  body: unknown;
}

export interface IdempotencyResult extends OperationResponse {
  isReplay: boolean;
}

export class IdempotencyConflictError extends Error {
  public readonly code = "IDEMPOTENCY_CONFLICT";

  public constructor() {
    super("IdempotencyConflictException: key belongs to another provider or payload");
    this.name = "IdempotencyConflictError";
  }
}

// Guards connection misuse only. Receipts and synchronization live in PostgreSQL.
const activeClients = new WeakSet<Client>();

export class IdempotencyEngine {
  public static async process(
    client: Client,
    key: string,
    providerId: string,
    payload: unknown,
    executeOperation: (transaction: Client) => Promise<OperationResponse>,
  ): Promise<IdempotencyResult> {
    if (typeof key !== "string" || !key.trim() || key.length > 128 ||
        typeof providerId !== "string" || !providerId.trim() || providerId.length > 64) {
      throw new Error("Invalid idempotency key or provider identity");
    }
    const currentHash = computeCanonicalSha256(payload);
    if (activeClients.has(client) || client.getTransactionStatus() !== "I") {
      throw new Error("IdempotencyEngine requires an idle, exclusively owned PostgreSQL client");
    }
    activeClients.add(client);
    try {
      // This boundary owns the transaction. All SQL effects must use this client.
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL lock_timeout = '5s'");
      // One transaction-scoped lock per key, including when no receipt exists yet.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`idempotency:${key}`]);
      const existing = await client.query<{
        provider_id: string;
        payload_hash: string;
        response_status: number;
        response_body: unknown;
      }>("SELECT provider_id, payload_hash, response_status, response_body FROM idempotency_keys WHERE key = $1", [key]);
      const record = existing.rows[0];
      if (record) {
        if (record.provider_id !== providerId || record.payload_hash !== currentHash) {
          throw new IdempotencyConflictError();
        }
        await client.query("COMMIT");
        return { isReplay: true, status: record.response_status, body: record.response_body };
      }
      const result = await executeOperation(client);
      const serializedBody = canonicalize(result.body);
      await client.query(
        "INSERT INTO idempotency_keys (key, provider_id, payload_hash, response_status, response_body) VALUES ($1, $2, $3, $4, $5)",
        [key, providerId, currentHash, result.status, serializedBody],
      );
      await client.query("COMMIT");
      return { isReplay: false, status: result.status, body: JSON.parse(serializedBody) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      activeClients.delete(client);
    }
  }
}
