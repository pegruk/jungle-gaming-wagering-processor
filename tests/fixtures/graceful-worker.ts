import { Database } from "../../src/infra/database/database";
import { FinanceService } from "../../src/application/finance.service";
import { SqsGateway } from "../../src/infra/messaging/sqs";
import { Workers } from "../../src/infra/messaging/workers";

const db = await Database.connect(process.env.DATABASE_URL!, process.env.DATABASE_SCHEMA!, 8);
const gateway = new SqsGateway(undefined, 2);
for (const [name, url] of Object.entries(JSON.parse(process.env.TEST_QUEUE_URLS!)))
  gateway.urls.set(name, String(url));
const workers = new Workers(new FinanceService(db), gateway, {
  async afterFinancialCommit() {
    process.stdout.write("COMMITTED\n");
    await Bun.sleep(250);
  },
});
process.on("SIGTERM", () => {
  void (async () => {
    await workers.stop();
    await db.close();
    gateway.close();
  })().catch(() => {
    process.exitCode = 1;
  });
});
workers.start();
