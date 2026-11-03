import { PGlite } from "@electric-sql/pglite";
import { randomBytes } from "node:crypto";
import { postgres } from "../src/db.js";
import { migrate, type Database, type Queryable } from "../src/db.js";
import { Store } from "../src/store.js";
import { Vault } from "../src/crypto.js";
import { MailService } from "../src/service.js";
import {
  baseCapabilities,
  MailError,
  type MailProvider,
  type Principal,
  type Message,
} from "../src/domain.js";
export const alice: Principal = {
  tenant: "personal",
  subject: "alice",
  client: "mcp-test",
  scopes: ["mail.read", "mail.write", "mail.send"],
};
export const message: Message = {
  id: "m1",
  from: "sender@example.com",
  to: ["test@example.com"],
  subject: "测试发票",
  text: "Invoice 发票内容",
  date: "2026-11-04T00:00:00Z",
  read: false,
  attachments: [],
  messageId: "<m1@example.com>",
};
export class LabProvider implements MailProvider {
  capabilities = { ...baseCapabilities };
  sends = 0;
  failSend = false;
  messages = [message];
  async verify() {
    return { email: "test@example.com" };
  }
  async search() {
    return { items: this.messages, coverage: "lab-fixture" };
  }
  async get(mid: string) {
    const m = this.messages.find((x) => x.id === mid);
    if (!m) throw new MailError("NOT_FOUND", 404);
    return m;
  }
  async attachment() {
    return {
      content: Buffer.from("test"),
      type: "text/plain",
      name: "fixture.txt",
    };
  }
  async folders() {
    return [{ id: "INBOX", name: "INBOX" }];
  }
  async mutate(mid: string) {
    return this.get(mid);
  }
  async send() {
    this.sends++;
    if (this.failSend) throw new Error("simulated lost final confirmation");
    return { state: "provider_accepted" as const, providerId: "lab-result" };
  }
}
export async function fixture(provider = new LabProvider()) {
  const engine = new PGlite();
  await engine.waitReady;
  const q = (e: any): Queryable => ({
    async query<T>(sql: string, params?: unknown[]) {
      if (
        !params?.length &&
        sql.split(";").filter((x) => x.trim()).length > 1
      ) {
        await e.exec(sql);
        return { rows: [] };
      }
      const r = await e.query(sql, params);
      return { rows: r.rows as T[], rowCount: r.affectedRows };
    },
  });
  let db: Database = {
    ...q(engine),
    transaction: (fn) => engine.transaction((tx) => fn(q(tx))),
    close: () => engine.close(),
  };
  if (process.env.TEST_DATABASE_URL) {
    await engine.close();
    const url = new URL(process.env.TEST_DATABASE_URL);
    if (
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      !url.pathname.startsWith("/anymail_test")
    )
      throw new Error("Tests require a dedicated local anymail_test database");
    const admin = postgres(url.href),
      schema = "test_" + randomBytes(8).toString("hex");
    await admin.query("CREATE SCHEMA " + schema);
    url.searchParams.set("options", "-csearch_path=" + schema);
    const live = postgres(url.href);
    db = {
      ...live,
      close: async () => {
        await live.close();
        await admin.query("DROP SCHEMA " + schema + " CASCADE");
        await admin.close();
      },
    };
  }
  await migrate(db);
  const store = new Store(db),
    vault = new Vault(Buffer.alloc(32, 7).toString("base64"));
  const service = new MailService(
    store,
    vault,
    async () => provider,
    "http://localhost:3000",
  );
  const account = await service.connect(
    alice,
    {
      provider: "gmail",
      email: "test@example.com",
      oauth: { accessToken: "lab-access-token" },
    },
    true,
    true,
  );
  const content = {
    to: ["recipient@example.com"],
    cc: [],
    bcc: [],
    subject: "Subject",
    text: "Body",
    attachmentIds: [],
    references: [],
  };
  return {
    db,
    engine,
    store,
    vault,
    service,
    provider,
    account,
    content,
    close: () => db.close(),
  };
}
