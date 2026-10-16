export {};

const base = process.env.DEMO_URL || "http://localhost:3000";

async function post(path: string, body: unknown, key?: string) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });
  return { http: response.status, body: (await response.json()) as Record<string, unknown> };
}
const opening = await post("/wallets", {
  playerId: crypto.randomUUID(),
  initialBalance: { amount: "100.00", currency: "BRL" },
});
if (opening.http !== 201) throw new Error("Start the application before running the demo");
const requests = Array.from({ length: 2 }, () => ({
  providerId: "demo",
  externalTransactionId: crypto.randomUUID(),
  walletId: opening.body.id,
  playerId: opening.body.playerId,
  roundId: "demo-round",
  gameId: "demo-game",
  kind: "BET",
  money: { amount: "80.00", currency: "BRL" },
}));
const results = await Promise.all(
  requests.map((input) => post("/wagering/transactions", input, input.externalTransactionId)),
);
const winner = results.findIndex((result) => result.http === 200);
if (winner < 0) throw new Error("No wager was processed");
const input = requests[winner]!;
const replay = await post("/wagering/transactions", input, input.externalTransactionId);
const reconciliation = await post(`/wallets/${opening.body.id}/reconciliation`, {});
process.stdout.write(
  JSON.stringify({ opening, simultaneousBets: results, replay, reconciliation }, null, 2) + "\n",
);
if (
  results.filter((result) => result.http === 200).length !== 1 ||
  replay.body.idempotentReplay !== true ||
  reconciliation.body.consistent !== true
)
  process.exitCode = 1;
