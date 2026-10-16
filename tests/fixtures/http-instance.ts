import { Database } from "../../src/infra/database/database";
import { FinanceService } from "../../src/application/finance.service";
import { QueriesService } from "../../src/application/queries.service";
import { SqsGateway } from "../../src/infra/messaging/sqs";
import { createHttpApp } from "../../src/infra/http/app";

const db = await Database.connect(process.env.DATABASE_URL!, process.env.DATABASE_SCHEMA!, 8);
const gateway = new SqsGateway();
const app = await createHttpApp(new FinanceService(db), new QueriesService(db, "test"), gateway);
await app.listen(0, "127.0.0.1");
process.stdout.write(JSON.stringify({ url: await app.getUrl() }) + "\n");
async function close() {
  await app.close();
  gateway.close();
  await db.close();
}
process.on("SIGTERM", () => {
  void close();
});
