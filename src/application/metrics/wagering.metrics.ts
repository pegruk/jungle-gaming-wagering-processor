import { Counter, Gauge, Histogram, Registry } from "prom-client";

export const registry = new Registry();

export const transactionsTotal = new Counter({
  name: "wagering_transactions_total",
  help: "Total number of wagering transactions processed",
  labelNames: ["status", "type"],
  registers: [registry],
});

export const hotWalletLockDuration = new Histogram({
  name: "wagering_hot_wallet_lock_duration_seconds",
  help: "Duration of pessimistic locks on hot wallets in seconds",
  registers: [registry],
});

export const outboxLagTotal = new Gauge({
  name: "wagering_outbox_lag_total",
  help: "Total number of messages lagging in the transactional outbox",
  registers: [registry],
});

export const WageringMetrics = {
  transactionsTotal,
  hotWalletLockDuration,
  outboxLagTotal,
  registry,
};
