import { cpus, totalmem, platform, release } from "node:os";
import { mkdir } from "node:fs/promises";

const base = process.env.LOAD_URL || "http://localhost:3000";
const concurrency = Number(process.env.LOAD_CONCURRENCY || 4);
const durationSeconds = Number(process.env.LOAD_DURATION_SECONDS || 10);
const mode = process.env.LOAD_MODE || "distributed";
const walletCount = mode === "hot" ? 1 : Number(process.env.LOAD_WALLETS || 10);
const drainTimeoutSeconds = Number(process.env.LOAD_DRAIN_TIMEOUT_SECONDS || 30);
if (
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 100 ||
  !Number.isInteger(walletCount) ||
  walletCount < 1 ||
  walletCount > 100 ||
  !Number.isFinite(durationSeconds) ||
  durationSeconds < 1 ||
  durationSeconds > 300 ||
  !["hot", "distributed"].includes(mode) ||
  !Number.isFinite(drainTimeoutSeconds) ||
  drainTimeoutSeconds < 0 ||
  drainTimeoutSeconds > 300
)
  throw new Error("Invalid load settings");

async function post(path: string, body: unknown, key?: string): Promise<Response> {
  return fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}

async function metrics() {
  const response = await fetch(base + "/metrics");
  if (!response.ok) throw new Error("Metrics unavailable");
  const content = await response.text();
  const value = (name: string) =>
    Number(content.match(new RegExp(`^${name} ([^\\n]+)$`, "m"))?.[1] || 0);
  return {
    lockConflicts: value("wagering_lock_conflicts_total"),
    outboxLagSeconds: value("wagering_outbox_lag_seconds"),
    outboxPending: value("wagering_outbox_lag_total"),
  };
}

if (!(await fetch(base + "/health/ready")).ok)
  throw new Error("Application is not ready; start Docker Compose first");
const wallets: { id: string; playerId: string }[] = [];
for (let index = 0; index < walletCount; index++) {
  const result = await post("/wallets", {
    playerId: crypto.randomUUID(),
    initialBalance: { amount: "1000000.00", currency: "BRL" },
  });
  if (!result.ok) throw new Error(`Wallet setup failed: ${result.status}`);
  wallets.push((await result.json()) as { id: string; playerId: string });
}
function payload(index: number) {
  const wallet = wallets[index % wallets.length]!;
  return {
    providerId: "load-test",
    externalTransactionId: crypto.randomUUID(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: "load-round",
    gameId: "load-game",
    kind: "BET",
    money: { amount: "0.01", currency: "BRL" },
  };
}
// Warm up the exact same endpoint; these requests are excluded from reported samples.
for (let index = 0; index < 10; index++) {
  const input = payload(index);
  if (!(await post("/wagering/transactions", input, input.externalTransactionId)).ok)
    throw new Error("Warmup failed");
}
const before = await metrics();
const latencies: number[] = [];
const statuses: Record<string, number> = {};
let replays = 0;
let errors = 0;
let maximumOutboxPending = before.outboxPending;
let maximumOutboxLagSeconds = before.outboxLagSeconds;
const sampler = setInterval(() => {
  void metrics()
    .then((sample) => {
      maximumOutboxPending = Math.max(maximumOutboxPending, sample.outboxPending);
      maximumOutboxLagSeconds = Math.max(maximumOutboxLagSeconds, sample.outboxLagSeconds);
    })
    .catch(() => {});
}, 1000);
const startedAt = new Date();
const start = performance.now();
const deadline = start + durationSeconds * 1000;
await Promise.all(
  Array.from({ length: concurrency }, async (_, worker) => {
    let count = 0;
    let previous = payload(worker);
    while (performance.now() < deadline) {
      const input = count > 0 && count % 5 === 0 ? previous : payload(count + worker);
      previous = input;
      const requestStarted = performance.now();
      try {
        const response = await post("/wagering/transactions", input, input.externalTransactionId);
        statuses[response.status] = (statuses[response.status] || 0) + 1;
        if (!response.ok) errors++;
        const body = (await response.json()) as { idempotentReplay?: boolean };
        if (body.idempotentReplay) replays++;
      } catch {
        errors++;
        statuses.network_error = (statuses.network_error || 0) + 1;
      }
      latencies.push(performance.now() - requestStarted);
      count++;
    }
  }),
);
const elapsedSeconds = (performance.now() - start) / 1000;
clearInterval(sampler);
const after = await metrics();
maximumOutboxPending = Math.max(maximumOutboxPending, after.outboxPending);
maximumOutboxLagSeconds = Math.max(maximumOutboxLagSeconds, after.outboxLagSeconds);
const drainStarted = performance.now();
let drained = after;
while (drained.outboxPending > 0 && performance.now() - drainStarted < drainTimeoutSeconds * 1000) {
  await Bun.sleep(250);
  drained = await metrics();
}
const drainWaitMilliseconds = performance.now() - drainStarted;
let consistent = true;
for (const wallet of wallets) {
  const response = await post(`/wallets/${wallet.id}/reconciliation`, {});
  if (!response.ok || !((await response.json()) as { consistent: boolean }).consistent)
    consistent = false;
}
latencies.sort((a, b) => a - b);
const percentile = (fraction: number) =>
  latencies[Math.min(latencies.length - 1, Math.ceil(fraction * latencies.length) - 1)] ?? 0;
const report = {
  startedAt: startedAt.toISOString(),
  environment: {
    bun: Bun.version,
    os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    totalMemoryGiB: Number((totalmem() / 1024 ** 3).toFixed(2)),
    target: base,
    applicationInstances: process.env.LOAD_INSTANCES || "1",
    telemetryEnabled: process.env.OTEL_ENABLED || "unknown",
  },
  methodology: {
    mode,
    concurrency,
    walletCount,
    requestedDurationSeconds: durationSeconds,
    elapsedSeconds,
    warmupRequests: 10,
    operation: "BET 0.01 BRL",
    duplicatePattern: "Every fifth request per worker repeats its previous payload and key",
    transport: "HTTP; PostgreSQL and SQS via Docker Compose",
  },
  results: {
    requests: latencies.length,
    throughputRequestsPerSecond: latencies.length / elapsedSeconds,
    latencyMilliseconds: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
    replays,
    errors,
    errorRate: errors / Math.max(1, latencies.length),
    statuses,
    lockConflicts: after.lockConflicts - before.lockConflicts,
    outbox: {
      before,
      atEnd: after,
      maximumObservedPending: maximumOutboxPending,
      maximumObservedLagSeconds: maximumOutboxLagSeconds,
      afterDrain: drained,
      drainWaitMilliseconds,
    },
    allWalletsReconciled: consistent,
  },
};
await mkdir("reports", { recursive: true });
const path = `reports/load-${mode}-${startedAt.toISOString().replaceAll(":", "-")}.json`;
await Bun.write(path, JSON.stringify(report, null, 2) + "\n");
process.stdout.write(JSON.stringify({ report: path, ...report.results }, null, 2) + "\n");
if (errors || !consistent) process.exitCode = 1;
