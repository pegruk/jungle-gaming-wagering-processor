import { Pool, type PoolClient } from "pg";
import { migrate } from "../../scripts/migrate";

export interface TestDatabase {
  pool: Pool;
  schema: string;
  connectionString: string;
  close(): Promise<void>;
}

// Each suite owns a fresh schema. Never migrate or clear the developer's tables.
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
  return {
    pool,
    schema,
    connectionString,
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
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
