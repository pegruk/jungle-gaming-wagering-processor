import { Counter, Gauge, Histogram, Registry } from "prom-client";

export const registry = new Registry();

export const transactionsTotal = new Counter({
  name: "wagering_transactions_total",
  help: "Total number of wagering transactions processed",
  labelNames: ["status", "type"],
  registers: [registry],
});

export const hotWalletLockDuration = new Histogram({
  name: "wagering_wallet_lock_wait_seconds",
  help: "Time waiting to acquire the wallet row lock",
  registers: [registry],
});

export const outboxLagTotal = new Gauge({
  name: "wagering_outbox_lag_total",
  help: "Total number of messages lagging in the transactional outbox",
  registers: [registry],
});

export const duplicatesTotal = new Counter({
  name: "wagering_duplicates_total",
  help: "Persistent duplicate requests detected",
  registers: [registry],
});

export const retriesTotal = new Counter({
  name: "wagering_retries_total",
  help: "Retry attempts",
  labelNames: ["component"],
  registers: [registry],
});

export const dlqTotal = new Counter({
  name: "wagering_dlq_total",
  help: "Messages routed to DLQ",
  registers: [registry],
});

export const lockConflictsTotal = new Counter({
  name: "wagering_lock_conflicts_total",
  help: "Lock timeouts, deadlocks and serialization failures",
  registers: [registry],
});

export const processingLatency = new Histogram({
  name: "wagering_processing_duration_seconds",
  help: "End-to-end use case latency including commit",
  registers: [registry],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 15],
});

export const outboxLagSeconds = new Gauge({
  name: "wagering_outbox_lag_seconds",
  help: "Age of oldest unpublished event",
  registers: [registry],
});

export const reconciliationMismatches = new Counter({
  name: "wagering_reconciliation_mismatches_total",
  help: "Reconciliation inconsistencies",
  registers: [registry],
});

export const WageringMetrics = {
  transactionsTotal,
  hotWalletLockDuration,
  outboxLagTotal,
  registry,
};
