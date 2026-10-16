import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createTestApplication } from "../helpers/application";
import { firstLine } from "../helpers/process";

describe("Three independent NestJS instances sharing PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createTestApplication>>;
  const instances: { process: ReturnType<typeof Bun.spawn>; url: string }[] = [];
  const context = { correlationId: "multi-process" };

  beforeAll(async () => {
    fixture = await createTestApplication();
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        const child = Bun.spawn([process.execPath, "tests/fixtures/http-instance.ts"], {
          stdout: "pipe",
          stderr: "inherit",
          env: {
            ...process.env,
            LOG_LEVEL: "silent",
            DATABASE_URL: fixture.connectionString,
            DATABASE_SCHEMA: fixture.schema,
          },
        });
        try {
          instances.push({ process: child, url: JSON.parse(await firstLine(child.stdout)).url });
        } catch (error) {
          child.kill();
          throw error;
        }
      }),
    );
  }, 60000);

  afterEach(async () => {
    await fixture.verify();
  });

  afterAll(async () => {
    for (const instance of instances) instance.process.kill("SIGTERM");
    await Promise.all(instances.map((instance) => instance.process.exited));
    await fixture?.close();
  });

  async function wallet() {
    return fixture.service.createWallet(
      { playerId: crypto.randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" } },
      context,
    );
  }
  function bet(current: Awaited<ReturnType<typeof wallet>>, id = crypto.randomUUID()) {
    return {
      providerId: "multi",
      externalTransactionId: id,
      playerId: current.playerId,
      walletId: current.id,
      roundId: "round",
      gameId: "game",
      kind: "BET",
      money: { amount: "80.00", currency: "BRL" },
    };
  }
  async function submit(input: ReturnType<typeof bet>, index: number) {
    const response = await fetch(
      instances[index % instances.length]!.url + "/wagering/transactions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": input.externalTransactionId,
        },
        body: JSON.stringify(input),
      },
    );
    return {
      code: response.status,
      body: (await response.json()) as { status: string; idempotentReplay: boolean },
    };
  }
  async function consistent(id: string, expected: string) {
    const row = (
      await fixture.pool.query(
        `SELECT w.balance,coalesce(sum(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END),0)::numeric(16,2)::text AS calculated
      FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id=w.id WHERE w.id=$1 GROUP BY w.id`,
        [id],
      )
    ).rows[0];
    expect(row.balance).toBe(expected);
    expect(row.calculated).toBe(expected);
  }

  it("accepts 50 parallel copies of one wager across all three instances with one debit", async () => {
    const current = await wallet();
    const input = bet(current);
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) => submit(input, index)),
    );
    expect(results.every((result) => result.code === 200)).toBe(true);
    expect(results.filter((result) => !result.body.idempotentReplay)).toHaveLength(1);
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::integer AS count FROM wallet_ledger_entries WHERE wallet_id=$1 AND direction='DEBIT'",
          [current.id],
        )
      ).rows[0].count,
    ).toBe(1);
    await consistent(current.id, "20.00");
  }, 20000);

  it("accepts exactly one of two competing bets and processes separate wallets in parallel", async () => {
    const current = await wallet();
    const competing = await Promise.all([submit(bet(current), 0), submit(bet(current), 1)]);
    expect(competing.map((result) => result.code).sort()).toEqual([200, 422]);
    await consistent(current.id, "20.00");
    const different = await Promise.all(Array.from({ length: 6 }, wallet));
    const results = await Promise.all(different.map((item, index) => submit(bet(item), index)));
    expect(results.every((result) => result.code === 200)).toBe(true);
    await Promise.all(different.map((item) => consistent(item.id, "20.00")));
  });

  it("preserves replay and ledger after an application instance restarts", async () => {
    const current = await wallet();
    const input = bet(current);
    await submit(input, 0);
    instances[0]!.process.kill("SIGTERM");
    await instances[0]!.process.exited;
    const child = Bun.spawn([process.execPath, "tests/fixtures/http-instance.ts"], {
      stdout: "pipe",
      stderr: "inherit",
      env: {
        ...process.env,
        LOG_LEVEL: "silent",
        DATABASE_URL: fixture.connectionString,
        DATABASE_SCHEMA: fixture.schema,
      },
    });
    instances[0] = { process: child, url: JSON.parse(await firstLine(child.stdout)).url };
    const replay = await submit(input, 0);
    expect(replay.body.idempotentReplay).toBe(true);
    await consistent(current.id, "20.00");
  }, 15000);
});
