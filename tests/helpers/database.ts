import { Pool, type PoolClient } from "pg";
import { migrate } from "../../scripts/migrate";

export interface TestDatabase {
  pool: Pool;
  schema: string;
  connectionString: string;
  verify(): Promise<void>;
  close(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const schema = `test_${crypto.randomUUID().replaceAll("-", "")}`;
  const connectionString =
    process.env.DATABASE_URL ||
    `postgresql://postgres:postgrespassword@localhost:${process.env.POSTGRES_PORT || "5433"}/distributed_wagering_processor`;
  const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  const pool = new Pool({
    connectionString,
    options: `-c search_path=${schema},public`,
    max: 55,
    connectionTimeoutMillis: 5000,
  });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try {
      await migrate(client);
    } finally {
      client.release();
    }
  } catch (error) {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
    throw error;
  }
  const verify = async () => {
    const wallets =
      await pool.query(`SELECT w.id FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id=w.id
      GROUP BY w.id HAVING w.balance <> coalesce(sum(CASE WHEN l.direction='CREDIT' THEN l.amount ELSE -l.amount END),0)`);
    if (wallets.rows.length)
      throw new Error("Final invariant failed: wallet balance differs from ledger");
    const journal =
      await pool.query(`SELECT transaction_id FROM journal_postings GROUP BY transaction_id
      HAVING count(*)<>2 OR sum(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END)<>0`);
    if (journal.rows.length) throw new Error("Final invariant failed: journal is not balanced");
  };
  return {
    pool,
    schema,
    connectionString,
    verify,
    async close() {
      try {
        await verify();
      } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    },
  };
}

export async function withClient<T>(
  pool: Pool,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await action(client);
  } finally {
    client.release();
  }
}
