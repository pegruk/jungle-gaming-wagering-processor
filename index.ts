import { startTelemetry, log } from "./src/infra/observability/telemetry";
import { Client } from "pg";
import { migrate } from "./scripts/migrate";
import { Database } from "./src/infra/database/database";
import { FinanceService } from "./src/application/finance.service";
import { QueriesService } from "./src/application/queries.service";
import { SqsGateway } from "./src/infra/messaging/sqs";
import { Workers } from "./src/infra/messaging/workers";
import { createHttpApp } from "./src/infra/http/app";

const telemetry = startTelemetry();
const url =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgrespassword@localhost:5433/distributed_wagering_processor";
const schema = process.env.DATABASE_SCHEMA || "wagering";
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error("Invalid database schema");
if (process.env.RUN_MIGRATIONS !== "false") {
  const client = new Client({ connectionString: url, options: `-c search_path=${schema},public` });
  try {
    await client.connect();
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await migrate(client);
  } finally {
    await client.end();
  }
}
const db = await Database.connect(url, schema);
const finance = new FinanceService(db);
const queries = new QueriesService(
  db,
  process.env.CURSOR_SECRET || "local-development-cursor-secret",
);
const sqs = new SqsGateway();
const workers = new Workers(finance, sqs);
const app = await createHttpApp(finance, queries, sqs);
await app.listen(Number(process.env.PORT || 3000), "0.0.0.0");
if (process.env.WORKERS_ENABLED !== "false") workers.start();
log("application.started", {
  port: Number(process.env.PORT || 3000),
  workers: process.env.WORKERS_ENABLED !== "false",
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // Stop accepting HTTP work, drain current queue work, then close dependencies.
  await app.close();
  await workers.stop();
  await db.close();
  sqs.close();
  await telemetry?.shutdown();
  log("application.stopped", {});
}
process.on("SIGTERM", () => {
  void shutdown();
});

process.on("SIGINT", () => {
  void shutdown();
});
