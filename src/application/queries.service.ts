import { createHmac, timingSafeEqual } from "node:crypto";
import { Database } from "../infra/database/database";
import { ApplicationError } from "./contracts";
import { rehydrateWager, type WagerRow } from "./finance.service";
import { Money } from "../domain/value-objects/money";
import { reconciliationMismatches } from "./metrics/wagering.metrics";
import { log } from "../infra/observability/telemetry";

export class QueriesService {
  constructor(
    readonly db: Database,
    private readonly cursorSecret: string,
  ) {}

  async wallet(id: string) {
    const found = await this.db.session().wallet(id);
    if (!found) throw new ApplicationError(404, "WALLET_NOT_FOUND");
    return {
      id,
      playerId: found.record.playerId,
      balance: found.aggregate.getBalance().toJSON(),
      version: found.record.version,
    };
  }

  async transaction(id: string) {
    const result = await this.db
      .session()
      .query<WagerRow>("SELECT * FROM wager_transactions WHERE id=$1", [id]);
    if (!result.rows[0]) throw new ApplicationError(404, "TRANSACTION_NOT_FOUND");
    return this.view(result.rows[0]);
  }

  async external(providerId: string, externalId: string) {
    const result = await this.db
      .session()
      .query<WagerRow>(
        "SELECT * FROM wager_transactions WHERE provider_id=$1 AND external_transaction_id=$2",
        [providerId, externalId],
      );
    if (!result.rows[0]) throw new ApplicationError(404, "TRANSACTION_NOT_FOUND");
    return this.view(result.rows[0]);
  }

  private view(row: WagerRow) {
    const state = rehydrateWager(row).toState();
    return {
      ...state,
      createdAt: state.createdAt.toISOString(),
      processedAt: state.processedAt?.toISOString(),
      result: row.response,
    };
  }

  async ledger(walletId: string, limitInput?: string, cursor?: string) {
    await this.wallet(walletId);
    const limit = limitInput === undefined ? 50 : Number(limitInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ApplicationError(400, "INVALID_LIMIT");
    let version = 0;
    if (cursor) {
      try {
        const [payload, signature] = cursor.split(".");
        const expected = createHmac("sha256", this.cursorSecret)
          .update(payload!)
          .digest("base64url");
        if (
          !signature ||
          signature.length !== expected.length ||
          !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
        )
          throw new Error();
        const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString());
        if (
          decoded.walletId !== walletId ||
          !Number.isInteger(decoded.version) ||
          decoded.version < 1
        )
          throw new Error();
        version = decoded.version;
      } catch {
        throw new ApplicationError(400, "INVALID_CURSOR");
      }
    }
    const result = await this.db
      .session()
      .query<Record<string, unknown> & { wallet_version: number; created_at: Date }>(
        "SELECT * FROM wallet_ledger_entries WHERE wallet_id=$1 AND wallet_version>$2 ORDER BY wallet_version LIMIT $3",
        [walletId, version, limit + 1],
      );
    const rows = result.rows.slice(0, limit);
    let nextCursor: string | null = null;
    if (result.rows.length > limit) {
      const payload = Buffer.from(
        JSON.stringify({ walletId, version: rows.at(-1)!.wallet_version }),
      ).toString("base64url");
      nextCursor = `${payload}.${createHmac("sha256", this.cursorSecret).update(payload).digest("base64url")}`;
    }
    return {
      entries: rows.map((row) => ({
        id: row.id,
        walletId: row.wallet_id,
        transactionId: row.transaction_id,
        direction: row.direction,
        money: { amount: row.amount, currency: row.currency },
        balanceBefore: { amount: row.balance_before, currency: row.currency },
        balanceAfter: { amount: row.balance_after, currency: row.currency },
        walletVersion: row.wallet_version,
        createdAt: row.created_at,
      })),
      nextCursor,
    };
  }

  async reconcile(id: string) {
    return this.db.transaction(async (sql) => {
      // Same lock as writes: wallet and ledger are observed at one committed point.
      const wallet = await sql.wallet(id, true);
      if (!wallet) throw new ApplicationError(404, "WALLET_NOT_FOUND");
      const result = await sql.query<{ calculated: string; entries: number }>(
        `SELECT
        coalesce(sum(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END),0)::numeric(16,2)::text AS calculated,
        count(*)::integer AS entries FROM wallet_ledger_entries WHERE wallet_id=$1`,
        [id],
      );
      const row = result.rows[0]!;
      const calculated = row.calculated.startsWith("-")
        ? Money.fromDecimal(row.calculated.slice(1), wallet.record.currency).negate()
        : Money.fromDecimal(row.calculated, wallet.record.currency);
      const difference = wallet.aggregate.getBalance().subtract(calculated);
      if (!difference.isZero()) {
        reconciliationMismatches.inc();
        log("wallet.reconciliation_mismatch", { walletId: id });
      }
      return {
        walletId: id,
        storedBalance: wallet.aggregate.getBalance().toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: row.entries,
      };
    });
  }
}
