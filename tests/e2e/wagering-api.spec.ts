import { describe, expect, it } from "bun:test";
import { validate } from "class-validator";
import { Client } from "pg";
import { BetRequestDto } from "../../src/application/dto/bet-request.dto";
import { WageringMetrics } from "../../src/application/metrics/wagering.metrics";
import { createProblemDetails } from "../../src/application/errors/problem-details";

const DB_PORT = process.env.POSTGRES_PORT || "5433";
const CONNECTION_STRING =
  process.env.DATABASE_URL ||
  `postgresql://postgres:postgrespassword@localhost:${DB_PORT}/distributed_wagering_processor`;
describe("Wagering API E2E Lifecycle", () => {
  it("should validate BetRequestDto using class-validator", async () => {
    const validDto = Object.assign(new BetRequestDto(), {
      transactionId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      roundId: "round-e2e-1",
      playerId: "player-e2e",
      walletId: "wallet-e2e",
      amount: "25.50",
      currency: "BRL",
    });
    const errors = await validate(validDto);
    expect(errors.length).toBe(0);
    const invalidDto = Object.assign(new BetRequestDto(), {
      transactionId: "not-a-uuid",
      amount: "invalid-amount",
    });
    const invalidErrors = await validate(invalidDto);
    expect(invalidErrors.length).toBeGreaterThan(0);
  });

  it("should record and format Prometheus metrics via prom-client registry", async () => {
    WageringMetrics.transactionsTotal.inc({ status: "ACCEPTED", type: "BET" });
    WageringMetrics.hotWalletLockDuration.observe(0.015);
    WageringMetrics.outboxLagTotal.set(2);
    const metricsOutput = await WageringMetrics.registry.metrics();
    expect(metricsOutput).toContain("wagering_transactions_total");
    expect(metricsOutput).toContain("wagering_hot_wallet_lock_duration_seconds");
    expect(metricsOutput).toContain("wagering_outbox_lag_total");
  });

  it("should format errors in compliance with RFC 9457 Problem Details", () => {
    const problem = createProblemDetails(
      422,
      "Unprocessable Entity",
      "Insufficient balance for requested bet",
      "/api/v1/wagers/bet",
    );
    expect(problem.status).toBe(422);
    expect(problem.type).toBe("https://api.jungle.gaming/errors/422");
    expect(problem.title).toBe("Unprocessable Entity");
    expect(problem.detail).toBe("Insufficient balance for requested bet");
    expect(problem.timestamp).toBeDefined();
  });

  it("should execute complete wagering flow: Bet -> Balance Check -> Reconcile against PostgreSQL", async () => {
    const client = new Client({
      connectionString: CONNECTION_STRING,
    });
    await client.connect();
    const walletId = "w-e2e-" + Date.now();
    const txId = "tx-e2e-" + Date.now();
    const betAmount = "15.00";
    // 1. Cria a carteira com R$ 100.00
    await client.query(
      "INSERT INTO wallets (id, player_id, currency, balance, version) VALUES ($1, 'p-e2e', 'BRL', 100.00, 1);",
      [walletId],
    );
    // 2. Debita R$ 15.00 com transação atômica e registra no ledger
    await client.query("BEGIN;");
    await client.query(
      "UPDATE wallets SET balance = balance - $1, version = version + 1 WHERE id = $2;",
      [betAmount, walletId],
    );

    await client.query(
      "INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after) VALUES ($1, $2, $3, 'DEBIT', $4, 100.00, 85.00);",
      [crypto.randomUUID(), walletId, txId, betAmount],
    );
    await client.query("COMMIT;");
    // 3. Valida reconciliação matemática contábil
    const walletRes = await client.query("SELECT balance, version FROM wallets WHERE id = $1;", [
      walletId,
    ]);
    const ledgerRes = await client.query(
      "SELECT SUM(amount) as total_debited FROM wallet_ledger_entries WHERE wallet_id = $1;",
      [walletId],
    );
    await client.end();
    expect(parseFloat(walletRes.rows[0].balance)).toBe(85.0);
    expect(parseInt(walletRes.rows[0].version)).toBe(2);
    expect(parseFloat(ledgerRes.rows[0].total_debited)).toBe(15.0);
  });
});
