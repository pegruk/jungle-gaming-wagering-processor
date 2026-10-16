import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createTestApplication } from "../helpers/application";
import { createHttpApp } from "../../src/infra/http/app";
import { QueriesService } from "../../src/application/queries.service";
import { SqsGateway } from "../../src/infra/messaging/sqs";

describe("HTTP API end to end", () => {
  let fixture: Awaited<ReturnType<typeof createTestApplication>>;
  let server: Awaited<ReturnType<typeof createHttpApp>>;
  let gateway: SqsGateway;
  let base: string;
  const request = async (path: string, body?: unknown, key?: string) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    fixture = await createTestApplication();
    gateway = new SqsGateway();
    server = await createHttpApp(
      fixture.service,
      new QueriesService(fixture.db, "e2e-secret"),
      gateway,
    );
    await server.listen(0, "127.0.0.1");
    base = await server.getUrl();
  });

  afterAll(async () => {
    await server?.close();
    gateway?.close();
    await fixture?.close();
  });

  afterEach(async () => {
    await fixture.verify();
  });

  it("creates a wallet, processes a wager, returns replay and supports every query", async () => {
    const create = await request("/wallets", {
      playerId: crypto.randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    expect(create.status).toBe(201);
    const wallet = (await create.json()) as { id: string; playerId: string };
    const payload = {
      providerId: "http-provider",
      externalTransactionId: crypto.randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: "round",
      gameId: "game",
      kind: "BET",
      money: { amount: "80.00", currency: "BRL" },
    };
    expect((await request("/wagering/transactions", payload)).status).toBe(400);
    const bet = await request("/wagering/transactions", payload, payload.externalTransactionId);
    expect(bet.status).toBe(200);
    const result = (await bet.json()) as { transactionId: string };
    const replay = await request("/wagering/transactions", payload, payload.externalTransactionId);
    expect(await replay.json()).toMatchObject({ ...result, idempotentReplay: true });
    expect(
      (
        await request(
          "/wagering/transactions",
          { ...payload, money: { amount: "1.00", currency: "BRL" } },
          payload.externalTransactionId,
        )
      ).status,
    ).toBe(409);

    expect(
      (
        await request(
          "/wagering/transactions",
          { ...payload, externalTransactionId: crypto.randomUUID() },
          crypto.randomUUID(),
        )
      ).status,
    ).toBe(422);
    expect((await request(`/wagering/transactions/${result.transactionId}`)).status).toBe(200);
    expect(
      (
        await request(
          `/providers/http-provider/wagering/transactions/${payload.externalTransactionId}`,
        )
      ).status,
    ).toBe(200);
    const page = (await (await request(`/wallets/${wallet.id}/ledger?limit=1`)).json()) as {
      entries: unknown[];
      nextCursor: string;
    };
    expect(page.entries).toHaveLength(1);
    expect(page.nextCursor).toBeString();
    const next = (await (
      await request(`/wallets/${wallet.id}/ledger?limit=1&cursor=${page.nextCursor}`)
    ).json()) as { entries: unknown[]; nextCursor: string | null };
    expect(next.entries).toHaveLength(1);
    expect(next.nextCursor).toBeNull();
    expect((await request(`/wallets/${wallet.id}/ledger?cursor=invalid`)).status).toBe(400);
    const reconciliation = await request(`/wallets/${wallet.id}/reconciliation`, {});
    expect(await reconciliation.json()).toMatchObject({
      consistent: true,
      checkedEntries: 2,
      storedBalance: { amount: "20.00", currency: "BRL" },
    });
  });

  it("distinguishes pending, invalid inputs, conflicts, not found and readiness", async () => {
    const playerId = crypto.randomUUID();
    const opening = { playerId, initialBalance: { amount: "0.00", currency: "BRL" } };
    const wallet = (await (await request("/wallets", opening)).json()) as { id: string };
    expect((await request("/wallets", opening)).status).toBe(409);
    expect(
      (await request("/wallets", { ...opening, initialBalance: { amount: 1, currency: "BRL" } }))
        .status,
    ).toBe(400);
    const payload = {
      providerId: "http-provider",
      externalTransactionId: crypto.randomUUID(),
      playerId,
      walletId: wallet.id,
      roundId: "round",
      gameId: "game",
      kind: "REFUND",
      referenceExternalTransactionId: "missing",
      money: { amount: "1.00", currency: "BRL" },
    };
    expect((await request("/wagering/transactions", payload, crypto.randomUUID())).status).toBe(
      202,
    );

    expect(
      (
        await request(
          "/wagering/transactions",
          { ...payload, kind: "OPENING" },
          crypto.randomUUID(),
        )
      ).status,
    ).toBe(400);
    expect((await request(`/wallets/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await request("/health/live")).status).toBe(200);
    expect((await request("/health/ready")).status).toBe(200);
    const metrics = await request("/metrics");
    expect(await metrics.text()).toContain("wagering_processing_duration_seconds");
    expect(metrics.headers.get("x-correlation-id")).toBeTruthy();
  });

  it("returns 503 for a real lock timeout and leaves the wager safe to retry", async () => {
    const wallet = await fixture.service.createWallet(
      { playerId: crypto.randomUUID(), initialBalance: { amount: "10.00", currency: "BRL" } },
      { correlationId: "lock-test" },
    );
    const client = await fixture.pool.connect();
    const key = crypto.randomUUID();
    const input = {
      providerId: "http-provider",
      externalTransactionId: key,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "lock",
      gameId: "game",
      kind: "BET",
      money: { amount: "1.00", currency: "BRL" },
    };
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM wallets WHERE id=$1 FOR UPDATE", [wallet.id]);
      const response = await request("/wagering/transactions", input, key);
      expect(response.status).toBe(503);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect((await request("/wagering/transactions", input, key)).status).toBe(200);
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::integer AS count FROM wager_transactions WHERE idempotency_key=$1",
          [key],
        )
      ).rows[0].count,
    ).toBe(1);
  }, 15000);
});
