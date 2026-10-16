import { EntitySchema, LockMode } from "@mikro-orm/core";
import { MikroORM, type EntityManager as PostgreSqlEntityManager } from "@mikro-orm/postgresql";
import { Wallet } from "../../domain/entities/wallet";
import { Money } from "../../domain/value-objects/money";

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema({
  class: WalletRecord, tableName: "wallets", properties: {
    id: { type: "string", primary: true }, playerId: { type: "string", fieldName: "player_id" },
    currency: { type: "string" }, balance: { type: "decimal", precision: 16, scale: 2, runtimeType: "string" },
    version: { type: "integer" }, createdAt: { type: "Date", fieldName: "created_at" }, updatedAt: { type: "Date", fieldName: "updated_at" },
  },
});

export class SqlSession {
  constructor(readonly em: PostgreSqlEntityManager) {}

  async query<T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const bindings: unknown[] = [];
    const query = sql.replace(/\$(\d+)/g, (_token, index: string) => { bindings.push(params[Number(index) - 1]); return "?"; });
    return { rows: await this.em.execute(query, bindings) as T[] };
  }

  async wallet(id: string, lock = false): Promise<{ record: WalletRecord; aggregate: Wallet } | undefined> {
    const record = await this.em.findOne(WalletRecord, { id }, lock ? { lockMode: LockMode.PESSIMISTIC_WRITE } : {});
    if (!record) return undefined;
    return { record, aggregate: Wallet.rehydrate({ ...record, balance: Money.fromDecimal(record.balance, record.currency) }) };
  }
}

export class Database {
  private constructor(readonly orm: MikroORM) {}

  static async connect(url: string, schema = "public", poolSize = 20): Promise<Database> {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error("Invalid database schema");
    const orm = await MikroORM.init({ clientUrl: url, schema, entities: [WalletSchema],
      driverOptions: { options: `-c search_path=${schema},public` },
      pool: { min: 0, max: poolSize }, debug: false });
    return new Database(orm);
  }

  async transaction<T>(action: (session: SqlSession) => Promise<T>): Promise<T> {
    return this.orm.em.fork().transactional(async (em) => {
      const session = new SqlSession(em as PostgreSqlEntityManager);
      await session.query("SET LOCAL lock_timeout = '5s'");
      return action(session);
    });
  }

  session(): SqlSession { return new SqlSession(this.orm.em.fork() as PostgreSqlEntityManager); }
  async close(): Promise<void> { await this.orm.close(); }
}
