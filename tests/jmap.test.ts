import test from "node:test";
import assert from "node:assert/strict";
import { JmapProvider } from "../src/providers/jmap.js";
import { draftSchema } from "../src/domain.js";
import type { HttpRequest } from "../src/network.js";
test("JMAP session, query, attachment and submission contracts", async (t) => {
  const methods: string[] = [];
  let crossOrigin = false;
  let uploaded: Buffer | undefined;
  const http: HttpRequest = async (url, options) => {
    let body: any;
    if (url.endsWith("/session"))
      body = {
        username: "test@example.com",
        apiUrl: crossOrigin
          ? "https://evil.invalid/api"
          : "https://jmap.invalid/api",
        uploadUrl: "https://jmap.invalid/upload/{accountId}",
        downloadUrl:
          "https://jmap.invalid/download/{accountId}/{blobId}/{name}",
        primaryAccounts: { "urn:ietf:params:jmap:mail": "a" },
      };
    else if (url.includes("/upload/")) {
      uploaded = Buffer.from(options!.body!);
      body = { blobId: "uploaded" };
    } else if (url.includes("/download/"))
      return { status: 200, headers: {}, body: Buffer.from("attachment") };
    else {
      const call = JSON.parse(String(options!.body)).methodCalls[0],
        method = call[0];
      methods.push(method);
      let result: any = {};
      if (method === "Email/query") result = { ids: ["m"], total: 1 };
      if (method === "Email/get")
        result = {
          list: [
            {
              id: "m",
              subject: "test",
              to: [{ email: "test@example.com" }],
              cc: [{ email: "cc@example.com" }],
              replyTo: [{ email: "reply@example.com" }],
              messageId: ["original@example.com"],
              references: ["prior@example.com"],
              receivedAt: "2026-11-04T00:00:00Z",
              bodyValues: { text: { value: "body" } },
              keywords: {},
              attachments: [
                { blobId: "b", name: "a.txt", type: "text/plain", size: 10 },
              ],
            },
          ],
        };
      if (method === "Mailbox/get")
        result = {
          list: [
            { id: "d", name: "Drafts", role: "drafts" },
            { id: "s", name: "Sent", role: "sent" },
          ],
        };
      if (method === "Email/import")
        result = { created: { draft: { id: "imported" } } };
      if (method === "Identity/get")
        result = { list: [{ id: "identity", email: "test@example.com" }] };
      if (method === "EmailSubmission/set")
        result = { created: { send: { id: "submitted" } } };
      body = { methodResponses: [[method, result, "0"]] };
    }
    return {
      status: 200,
      headers: {},
      body: Buffer.from(JSON.stringify(body)),
    };
  };
  const provider = () =>
    new JmapProvider(
      {
        provider: "jmap",
        email: "test@example.com",
        sessionUrl: "https://jmap.invalid/session",
        token: "synthetic-token",
      },
      http,
    );
  await t.test(
    "search/query returns message IDs and attachment membership",
    async () => {
      const p = provider();
      assert.equal((await p.verify()).email, "test@example.com");
      assert.equal(
        (await p.search({ query: "test", limit: 20 })).items.length,
        1,
      );
      assert.equal(
        (await p.attachment("m", "b")).content.toString(),
        "attachment",
      );
      await assert.rejects(p.attachment("m", "foreign"), /NOT_FOUND/);
    },
  );
  await t.test(
    "JMAP preserves reply recipients and RFC message-id brackets",
    async () => {
      const m = await provider().get("m");
      assert.deepEqual(m.cc, ["cc@example.com"]);
      assert.deepEqual(m.replyTo, ["reply@example.com"]);
      assert.equal(m.messageId, "<original@example.com>");
      assert.deepEqual(m.references, ["<prior@example.com>"]);
    },
  );
  await t.test(
    "submit uploads bytes, imports and uses approved identity",
    async () => {
      await provider().send(
        draftSchema.parse({
          to: ["to@example.com"],
          subject: "test",
          text: "正文",
        }),
        [],
        crypto.randomUUID(),
      );
      assert.ok(Buffer.isBuffer(uploaded));
      assert.ok(methods.includes("EmailSubmission/set"));
    },
  );
  await t.test(
    "session cannot redirect stored token to another origin",
    async () => {
      crossOrigin = true;
      await assert.rejects(provider().verify(), /CROSS_ORIGIN/);
    },
  );
});
