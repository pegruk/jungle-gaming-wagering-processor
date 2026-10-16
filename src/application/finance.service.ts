import { Database, SqlSession, WalletRecord } from "../infra/database/database";
import { Money } from "../domain/value-objects/money";
import { Wallet, InsufficientBalanceError } from "../domain/entities/wallet";
import { WalletLedgerEntry } from "../domain/entities/wallet-ledger-entry";
import {
  WagerTransaction,
  TransactionType,
  TransactionStatus,
  LedgerDirection,
  type WagerState,
} from "../domain/entities/wager-transaction";
import { DomainError } from "../domain/errors";
import {
  IntegrationEvent,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
  WalletBalanceChanged,
  type EventContext,
} from "../domain/events/integration-event";
import { computeCanonicalSha256 } from "../domain/utils/canonical-json";
import {
  ApplicationError,
  walletRequest,
  wagerRequest,
  idempotencyKey,
  sqlState,
} from "./contracts";
import { traced, log } from "../infra/observability/telemetry";
import {
  transactionsTotal,
  duplicatesTotal,
  processingLatency,
  lockConflictsTotal,
  retriesTotal,
} from "./metrics/wagering.metrics";
import { hotWalletLockDuration } from "./metrics/wagering.metrics";
import { InboxMessage } from "../domain/entities/inbox-message";
import { OutboxMessage } from "../domain/entities/outbox-message";

export interface TransactionResponse {
  transactionId: string;
  status: TransactionStatus;
  balance: { amount: string; currency: string };
  failureCode?: string;
  idempotentReplay: boolean;
}

export interface InboxContext {
  consumerName: string;
  messageId: string;
}

export interface WagerRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: TransactionType;
  amount: string;
  currency: string;
  status: TransactionStatus;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  failure_code: WagerState["failureCode"] | null;
  created_at: Date;
  processed_at: Date | null;
  response: TransactionResponse;
  correlation_id: string;
  pending_attempts: number;
  next_attempt_at: Date;
}

export function rehydrateWager(row: WagerRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind,
    money: { amount: row.amount, currency: row.currency },
    referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
    referenceTransactionId: row.reference_transaction_id ?? undefined,
    status: row.status,
    failureCode: row.failure_code ?? undefined,
    createdAt: new Date(row.created_at),
    processedAt: row.processed_at ? new Date(row.processed_at) : undefined,
  });
}

export class FinanceService {
  constructor(
    readonly db: Database,
    readonly referenceMaxAttempts = 8,
    readonly referenceTtlMs = 3600000,
  ) {}

  async createWallet(input: unknown, context: EventContext) {
    return traced("wallet.open", context, (ctx) => this.open(input, ctx));
  }

  private async open(input: unknown, context: EventContext) {
    const request = walletRequest(input);
    try {
      return await this.db.transaction(async (sql) => {
        const initial = Money.from(request.initialBalance);
        const wallet = Wallet.open({
          id: crypto.randomUUID(),
          playerId: request.playerId,
          initialBalance: initial,
        });
        const state = wallet.toState();
        const record = sql.em.create(WalletRecord, { ...state, balance: initial.toString() });
        sql.em.persist(record);
        await sql.em.flush();
        if (initial.isPositive()) {
          const transaction = WagerTransaction.create({
            id: crypto.randomUUID(),
            providerId: "__internal__",
            externalTransactionId: state.id,
            idempotencyKey: `opening:${state.id}`,
            payloadHash: computeCanonicalSha256(request),
            walletId: state.id,
            playerId: state.playerId,
            roundId: "opening",
            gameId: "opening",
            kind: TransactionType.OPENING,
            money: initial.toJSON(),
          });
          transaction.markProcessed(undefined, new Date());
          const entry = WalletLedgerEntry.create({
            id: crypto.randomUUID(),
            walletId: state.id,
            transactionId: transaction.id,
            direction: LedgerDirection.CREDIT,
            money: initial,
            balanceBefore: Money.zero(state.currency),
            balanceAfter: initial,
            walletVersion: 1,
            createdAt: new Date(),
          });
          await this.persist(sql, transaction, wallet, context, false, entry);
        }
        return { id: state.id, playerId: state.playerId, balance: initial.toJSON(), version: 1 };
      });
    } catch (error) {
      if (sqlState(error) === "23505") throw new ApplicationError(409, "WALLET_ALREADY_EXISTS");
      throw error;
    }
  }

  async submit(
    input: unknown,
    keyInput: unknown,
    context: EventContext,
    inbox?: InboxContext,
  ): Promise<TransactionResponse> {
    const end = processingLatency.startTimer();
    try {
      return await traced("wager.submit", context, async (ctx) => {
        const response = await this.process(input, keyInput, ctx, inbox);
        const request = wagerRequest(input);
        if (response.idempotentReplay) duplicatesTotal.inc();
        else transactionsTotal.inc({ status: response.status, type: request.kind });
        log("wager.completed", {
          correlationId: ctx.correlationId,
          messageId: inbox?.messageId ?? null,
          transactionId: response.transactionId,
          walletId: request.walletId,
          providerId: request.providerId,
          status: response.status,
          replay: response.idempotentReplay,
        });
        return response;
      });
    } catch (error) {
      if (["55P03", "40P01", "40001"].includes(sqlState(error) || "")) lockConflictsTotal.inc();
      throw error;
    } finally {
      end();
    }
  }

  private async process(
    input: unknown,
    keyInput: unknown,
    context: EventContext,
    inbox?: InboxContext,
  ): Promise<TransactionResponse> {
    const request = wagerRequest(input);
    const key = idempotencyKey(keyInput);
    const hash = computeCanonicalSha256(request);
    return this.db.transaction(async (sql) => {
      const locks = [
        `key:${key}`,
        `external:${request.providerId}:${request.externalTransactionId}`,
        ...(inbox ? [`inbox:${inbox.consumerName}:${inbox.messageId}`] : []),
      ].sort();
      for (const lock of locks)
        await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lock]);
      if (inbox) {
        const previous = await sql.query<{ payload_hash: string }>(
          "SELECT payload_hash FROM inbox_messages WHERE consumer_name=$1 AND message_id=$2",
          [inbox.consumerName, inbox.messageId],
        );
        if (previous.rows[0] && previous.rows[0].payload_hash !== hash)
          throw new ApplicationError(409, "INBOX_PAYLOAD_CONFLICT");
      }
      const found = await sql.query<WagerRow>(
        "SELECT * FROM wager_transactions WHERE idempotency_key=$1 OR (provider_id=$2 AND external_transaction_id=$3)",
        [key, request.providerId, request.externalTransactionId],
      );
      let response: TransactionResponse;
      if (found.rows.length) {
        const existing = found.rows[0]!;
        if (
          found.rows.length !== 1 ||
          existing.idempotency_key !== key ||
          existing.payload_hash !== hash ||
          existing.provider_id !== request.providerId
        ) {
          throw new ApplicationError(409, "IDEMPOTENCY_CONFLICT");
        }
        response = { ...existing.response, idempotentReplay: true };
      } else {
        const stopWaiting = hotWalletLockDuration.startTimer();
        const wallet = await sql.wallet(request.walletId, true).finally(stopWaiting);
        if (!wallet) throw new ApplicationError(404, "WALLET_NOT_FOUND");
        const transaction = WagerTransaction.create({
          ...request,
          id: crypto.randomUUID(),
          idempotencyKey: key,
          payloadHash: hash,
        });
        response = await this.apply(sql, transaction, wallet, context, false);
      }
      if (inbox) {
        const receipt = InboxMessage.receive({ ...inbox, payloadHash: hash });
        receipt.markProcessed(new Date());
        const saved = receipt.toState();
        await sql.query(
          `INSERT INTO inbox_messages (provider_id, consumer_name, message_id, payload_hash,received_at,processed_at)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (consumer_name,message_id) DO NOTHING`,
          [
            request.providerId,
            inbox.consumerName,
            inbox.messageId,
            hash,
            saved.receivedAt,
            saved.processedAt,
          ],
        );
      }
      return response;
    });
  }

  private async apply(
    sql: SqlSession,
    transaction: WagerTransaction,
    wallet: { record: WalletRecord; aggregate: Wallet },
    context: EventContext,
    existing: boolean,
    expired = false,
  ): Promise<TransactionResponse> {
    transaction.resume();
    const state = transaction.toState();
    let reference: WagerTransaction | undefined;
    let entry: WalletLedgerEntry | undefined;
    try {
      if (state.playerId !== wallet.record.playerId) throw new DomainError("PLAYER_MISMATCH");
      if (state.money.currency !== wallet.record.currency)
        throw new DomainError("CURRENCY_MISMATCH");
      if (expired) throw new DomainError("REFERENCE_EXPIRED");
      if (state.referenceExternalTransactionId) {
        if (state.referenceExternalTransactionId === state.externalTransactionId)
          throw new DomainError("REFERENCE_MISMATCH");
        const found = await sql.query<WagerRow>(
          "SELECT * FROM wager_transactions WHERE provider_id=$1 AND external_transaction_id=$2",
          [state.providerId, state.referenceExternalTransactionId],
        );
        reference = found.rows[0] ? rehydrateWager(found.rows[0]) : undefined;
        if (!reference) transaction.markPendingReference();
        else {
          try {
            transaction.validateReference(reference);
          } catch (error) {
            if (
              error instanceof DomainError &&
              error.code === "REFERENCE_NOT_PROCESSED" &&
              !reference.isTerminal()
            )
              transaction.markPendingReference();
            else throw error;
          }
        }
        if (
          reference &&
          transaction.requiresReference() &&
          transaction.status !== TransactionStatus.PENDING_REFERENCE
        ) {
          const reversed = await sql.query(
            "SELECT id FROM wager_transactions WHERE reference_transaction_id=$1 AND kind=$2 AND status='PROCESSED'",
            [reference.id, transaction.kind],
          );
          if (reversed.rows.length) throw new DomainError("ALREADY_REVERSED");
        }
      }
      if (transaction.status !== TransactionStatus.PENDING_REFERENCE) {
        if (transaction.affectsBalance()) {
          const direction = transaction.ledgerDirectionFor(reference);
          const result =
            direction === LedgerDirection.DEBIT
              ? wallet.aggregate.debit(
                  transaction.money,
                  transaction.kind === TransactionType.ROLLBACK,
                )
              : wallet.aggregate.credit(transaction.money);
          entry = WalletLedgerEntry.create({
            id: crypto.randomUUID(),
            walletId: state.walletId,
            transactionId: state.id,
            direction,
            money: transaction.money,
            ...result,
            createdAt: new Date(),
          });
          wallet.record.balance = result.balanceAfter.toString();
          wallet.record.version = result.walletVersion;
          wallet.record.updatedAt = new Date();
        }
        transaction.markProcessed(reference?.id, new Date());
      }
    } catch (error) {
      if (error instanceof DomainError || error instanceof InsufficientBalanceError)
        transaction.reject(error.code);
      else if (error instanceof Error && error.message.includes("NUMERIC(16, 2)"))
        transaction.reject("BALANCE_LIMIT_EXCEEDED");
      else throw error;
    }
    return this.persist(sql, transaction, wallet.aggregate, context, existing, entry);
  }

  private async persist(
    sql: SqlSession,
    transaction: WagerTransaction,
    wallet: Wallet,
    context: EventContext,
    existing: boolean,
    entry?: WalletLedgerEntry,
  ): Promise<TransactionResponse> {
    const state = transaction.toState();
    const response: TransactionResponse = {
      transactionId: state.id,
      status: state.status,
      balance: wallet.getBalance().toJSON(),
      ...(state.failureCode ? { failureCode: state.failureCode } : {}),
      idempotentReplay: false,
    };
    if (existing) {
      await sql.query(
        `UPDATE wager_transactions SET status=$2, reference_transaction_id=$3, failure_code=$4, processed_at=$5, response=$6 WHERE id=$1`,
        [
          state.id,
          state.status,
          state.referenceTransactionId ?? null,
          state.failureCode ?? null,
          state.processedAt ?? null,
          JSON.stringify(response),
        ],
      );
    } else {
      await sql.query(
        `INSERT INTO wager_transactions (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,
        reference_external_transaction_id,reference_transaction_id,status,failure_code,created_at,processed_at,response,correlation_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          state.id,
          state.providerId,
          state.externalTransactionId,
          state.idempotencyKey,
          state.payloadHash,
          state.walletId,
          state.playerId,
          state.roundId,
          state.gameId,
          state.kind,
          state.money.amount,
          state.money.currency,
          state.referenceExternalTransactionId ?? null,
          state.referenceTransactionId ?? null,
          state.status,
          state.failureCode ?? null,
          state.createdAt,
          state.processedAt ?? null,
          JSON.stringify(response),
          context.correlationId,
        ],
      );
    }
    if (entry) {
      const ledger = entry.toState();
      await sql.query(
        `INSERT INTO wallet_ledger_entries (id,wallet_id,transaction_id,direction,amount,balance_before,balance_after,currency,wallet_version,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          ledger.id,
          ledger.walletId,
          ledger.transactionId,
          ledger.direction,
          ledger.money.toString(),
          ledger.balanceBefore.toString(),
          ledger.balanceAfter.toString(),
          ledger.money.getCurrency(),
          ledger.walletVersion,
          ledger.createdAt,
        ],
      );

      await sql.query(
        `INSERT INTO journal_postings (transaction_id,account_id,direction,amount,currency)
        VALUES ($1,$2,$3,$4,$5),($1,$6,$7,$4,$5)`,
        [
          ledger.transactionId,
          `wallet:${ledger.walletId}`,
          ledger.direction,
          ledger.money.toString(),
          ledger.money.getCurrency(),
          `clearing:${ledger.money.getCurrency()}`,
          ledger.direction === LedgerDirection.CREDIT
            ? LedgerDirection.DEBIT
            : LedgerDirection.CREDIT,
        ],
      );

      await this.event(
        sql,
        WalletBalanceChanged.from({
          ...context,
          eventId: crypto.randomUUID(),
          aggregateId: state.walletId,
          occurredAt: new Date(),
          data: {
            walletId: state.walletId,
            transactionId: state.id,
            direction: ledger.direction,
            money: ledger.money.toJSON(),
            balanceBefore: ledger.balanceBefore.toJSON(),
            balanceAfter: ledger.balanceAfter.toJSON(),
            walletVersion: ledger.walletVersion,
          },
        }),
      );
    }
    if (!existing || transaction.status !== TransactionStatus.PENDING_REFERENCE) {
      const props = {
        ...context,
        eventId: crypto.randomUUID(),
        aggregateId: state.walletId,
        occurredAt: new Date(),
        data: {
          transactionId: state.id,
          walletId: state.walletId,
          providerId: state.providerId,
          status: state.status,
          ...(state.failureCode ? { failureCode: state.failureCode } : {}),
        },
      };
      const event =
        state.status === TransactionStatus.PROCESSED
          ? WagerTransactionProcessed.from(props)
          : state.status === TransactionStatus.REJECTED
            ? WagerTransactionRejected.from(props)
            : WagerTransactionPendingReference.from(props);
      await this.event(sql, event);
    }
    return response;
  }

  private async event(
    sql: SqlSession,
    event: IntegrationEvent<Record<string, unknown>>,
  ): Promise<void> {
    const message = OutboxMessage.enqueue(event).toState();
    await sql.query(
      "INSERT INTO outbox_messages (id,aggregate_id,event_type,payload) VALUES ($1,$2,$3,$4)",
      [message.id, message.aggregateId, message.eventType, JSON.stringify(message.payload)],
    );
  }

  async retryPending(limit = 20): Promise<number> {
    const candidates = await this.db
      .session()
      .query<{ id: string }>(
        "SELECT id FROM wager_transactions WHERE status='PENDING_REFERENCE' AND next_attempt_at<=now() ORDER BY next_attempt_at,id LIMIT $1",
        [limit],
      );
    let processed = 0;
    for (const candidate of candidates.rows) {
      await this.db.transaction(async (sql) => {
        const result = await sql.query<WagerRow>(
          "SELECT * FROM wager_transactions WHERE id=$1 AND status='PENDING_REFERENCE' AND next_attempt_at<=now() FOR UPDATE SKIP LOCKED",
          [candidate.id],
        );
        const row = result.rows[0];
        if (!row) return;
        retriesTotal.inc({ component: "reference" });
        const wallet = await sql.wallet(row.wallet_id, true);
        if (!wallet) throw new Error("Persisted transaction has no wallet");
        const expired =
          row.pending_attempts >= this.referenceMaxAttempts ||
          Date.now() - new Date(row.created_at).getTime() >= this.referenceTtlMs;
        const response = await this.apply(
          sql,
          rehydrateWager(row),
          wallet,
          { correlationId: row.correlation_id, causationId: row.id },
          true,
          expired,
        );
        if (response.status !== TransactionStatus.PENDING_REFERENCE)
          transactionsTotal.inc({ status: response.status, type: row.kind });
        if (response.status === TransactionStatus.PENDING_REFERENCE)
          await sql.query(
            "UPDATE wager_transactions SET pending_attempts=pending_attempts+1,next_attempt_at=now()+($2 * interval '1 millisecond') WHERE id=$1",
            [row.id, Math.min(300000, 1000 * 2 ** row.pending_attempts)],
          );
        processed++;
      });
    }
    return processed;
  }
}
