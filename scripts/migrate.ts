import { createHash } from "node:crypto";
import { Client } from "pg";

const directory = `${import.meta.dir}/migrations`;

// The caller provides an exclusively owned, connected client outside a transaction.
export async function migrate(client: Client, direction: "up" | "down" = "up"): Promise<void> {
  if (client.getTransactionStatus() !== "I") {
    throw new Error("Migrations require an idle PostgreSQL client");
  }
  await client.query("BEGIN");
  try {
    // Only migration runners share this lock. Financial operations never use it.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('jungle:schema-migrations', 0))",
    );

    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const applied = await client.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    );
    const known = new Map(applied.rows.map((row) => [row.version, row.checksum]));
    const files = [...new Bun.Glob("[0-9]*.sql").scanSync(directory)].sort();
    for (const file of files) {
      const sql = await Bun.file(`${directory}/${file}`).text();
      const checksum = createHash("sha256").update(sql).digest("hex");
      if (known.has(file) && known.get(file) !== checksum) {
        throw new Error(`Applied migration changed: ${file}`);
      }
      if (direction === "up" && !known.has(file)) {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [
          file,
          checksum,
        ]);
      }
    }
    if (direction === "down") {
      const last = applied.rows.at(-1)?.version;
      if (last) {
        if (!files.includes(last)) {
          throw new Error(`Unknown applied migration: ${last}`);
        }
        await client.query(await Bun.file(`${directory}/down/${last}`).text());
        await client.query("DELETE FROM schema_migrations WHERE version = $1", [last]);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

if (import.meta.main) {
  const direction = process.argv[2] ?? "up";
  if (direction !== "up" && direction !== "down") {
    throw new Error("Usage: bun scripts/migrate.ts [up|down]");
  }
  const client = new Client({
    connectionString:
      process.env.DATABASE_URL ||
      `postgresql://postgres:postgrespassword@localhost:${process.env.POSTGRES_PORT || "5433"}/distributed_wagering_processor`,
    connectionTimeoutMillis: 5000,
    options: `-c search_path=${process.env.DATABASE_SCHEMA || "wagering"},public`,
  });
  try {
    await client.connect();
    const schema = process.env.DATABASE_SCHEMA || "wagering";
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error("Invalid schema");
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await migrate(client, direction);
    process.stdout.write(`Migrations ${direction} completed\n`);
  } finally {
    await client.end();
  }
}
