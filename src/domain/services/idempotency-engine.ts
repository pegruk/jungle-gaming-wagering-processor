import { Client } from "pg";
import { computeCanonicalSha256 } from "../utils/canonical-json";

export class IdempotencyEngine {
  public static async process(
    client: Client,
    key: string,
    providerId: string,
    payload: unknown,
    executeOperation: () => Promise<{ status: number; body: unknown }>,
  ) {
    const currentHash = computeCanonicalSha256(payload);
    // 1. Consulta se a chave já foi registrada no banco
    const existing = await client.query(
      "SELECT payload_hash, response_status, response_body FROM idempotency_keys WHERE key = $1",
      [key],
    );
    if (existing.rows.length > 0) {
      const record = existing.rows[0];
      // Se o hash for idêntico, é um REPLAY PERFEITO (200 OK)
      if (record.payload_hash === currentHash) {
        return {
          isReplay: true,
          status: record.response_status,
          body: record.response_body,
        };
      }
      // Se o hash divergir, é uma TENTATIVA DE FRAUDE OU CONFLITO (409 Conflict)
      throw new Error(
        `IdempotencyConflictException: Key '${key}' was already used with a differing request payload`,
      );
    }
    // Executa a operação de negócio e grava o recibo
    const result = await executeOperation();
    await client.query(
      "INSERT INTO idempotency_keys (key, provider_id, payload_hash, response_status, response_body) VALUES ($1, $2, $3, $4, $5)",
      [key, providerId, currentHash, result.status, JSON.stringify(result.body)],
    );
    return { isReplay: false, status: result.status, body: result.body };
  }
}
