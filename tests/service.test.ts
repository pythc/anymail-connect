import { approvalPage } from "../src/ui.js";
import { hash } from "../src/crypto.js";
import { tools } from "../src/tools.js";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, alice, message } from "./helpers.js";
import { cleanHtml } from "../src/service.js";
import { Synchronizer } from "../src/sync.js";
test("persistent mail workflows, isolation, consent and recovery", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const draft = () => f.service.createDraft(alice, f.account.id, f.content);
  const prepared = async (dedupe = crypto.randomUUID()) => {
    const d = await draft();
    return f.service.prepare(alice, f.account.id, d.id, d.revision, dedupe);
  };
  await t.test("credentials encrypted and scoped by AAD", async () => {
    const a = await f.store.account(alice, f.account.id);
    assert.ok(!a.secret.includes("lab-access-token"));
    assert.throws(() => f.vault.open(a.secret, "another-tenant"));
    assert.equal("secret" in f.account, false);
  });
  await t.test("tenant, subject and scope isolation", async () => {
    for (const p of [
      { ...alice, tenant: "enterprise" },
      { ...alice, subject: "bob" },
      { ...alice, scopes: [] },
    ])
      await assert.rejects(f.service.get(p, f.account.id, "m1"));
  });
  await t.test("headers cannot inject recipient or subject lines", async () => {
    await assert.rejects(
      f.service.createDraft(alice, f.account.id, {
        ...f.content,
        subject: "x\r\nBcc: attacker@example.com",
      }),
    );
    await assert.rejects(
      f.service.createDraft(alice, f.account.id, {
        ...f.content,
        to: ["a@example.com\r\nBcc:b@example.com"],
      }),
    );
  });
  await t.test("HTML strips remote requests and active elements", () => {
    const html = cleanHtml(
      '<script>alert(1)</script><img src="https://evil.invalid/x"><p onclick="x()">safe</p><iframe src="x"></iframe>',
    );
    assert.equal(html, "<p>safe</p>");
  });
  await t.test(
    "draft revision rejects stale concurrent replacement",
    async () => {
      const d = await draft();
      const results = await Promise.allSettled([
        f.service.updateDraft(alice, f.account.id, d.id, 1, {
          ...f.content,
          text: "first",
        }),
        f.service.updateDraft(alice, f.account.id, d.id, 1, {
          ...f.content,
          text: "second",
        }),
      ]);
      assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
    },
  );
  await t.test("prepare is idempotent even as clock advances", async () => {
    const d = await draft();
    const a = await f.service.prepare(alice, f.account.id, d.id, 1, "same-key");
    await new Promise((r) => setTimeout(r, 5));
    const b = await f.service.prepare(alice, f.account.id, d.id, 1, "same-key");
    assert.equal(a.id, b.id);
  });
  await t.test("idempotency key cannot approve different content", async () => {
    const d = await draft();
    await f.service.prepare(alice, f.account.id, d.id, 1, "conflicting-key");
    const other = await draft();
    await assert.rejects(
      f.service.prepare(alice, f.account.id, other.id, 1, "conflicting-key"),
      /IDEMPOTENCY_CONFLICT/,
    );
  });
  await t.test("unapproved and altered digest sends rejected", async () => {
    const op = await prepared();
    await assert.rejects(
      f.service.submit(alice, op.id),
      /USER_APPROVAL_REQUIRED/,
    );
    await assert.rejects(
      f.service.approve(alice, op.id, "changed-digest"),
      /APPROVAL_INVALID/,
    );
  });
  await t.test(
    "concurrent submit and repeated submit send only once",
    async () => {
      const op = await prepared();
      await f.service.approve(alice, op.id, op.digest);
      const before = f.provider.sends;
      await Promise.all([
        f.service.submit(alice, op.id),
        f.service.submit(alice, op.id),
      ]);
      await f.service.submit(alice, op.id);
      assert.equal(f.provider.sends, before + 1);
      assert.equal(
        (await f.service.operation(alice, op.id)).state,
        "provider_accepted",
      );
    },
  );
  await t.test("post-approval draft edit invalidates submission", async () => {
    const op = await prepared();
    await f.service.approve(alice, op.id, op.digest);
    await f.service.updateDraft(alice, f.account.id, op.draftId, 1, {
      ...f.content,
      to: ["changed@example.com"],
    });
    assert.equal((await f.service.submit(alice, op.id)).state, "failed");
  });
  await t.test(
    "unknown send never retries, including worker restart",
    async () => {
      const op = await prepared();
      await f.service.approve(alice, op.id, op.digest);
      f.provider.failSend = true;
      const before = f.provider.sends;
      assert.equal((await f.service.submit(alice, op.id)).state, "unknown");
      await f.service.submit(alice, op.id);
      await f.service.tick();
      assert.equal(f.provider.sends, before + 1);
      f.provider.failSend = false;
    },
  );
  await t.test(
    "client cannot submit another client’s approved operation",
    async () => {
      const op = await prepared();
      await f.service.approve(alice, op.id, op.digest);
      await assert.rejects(
        f.service.submit({ ...alice, client: "other" }, op.id),
        /CLIENT_MISMATCH/,
      );
      await f.service.cancel(alice, op.id);
    },
  );
  await t.test(
    "expired approval and cancelled schedules cannot send",
    async () => {
      const op = await prepared();
      await f.db.query(
        "UPDATE operations SET data=jsonb_set(data,'{expiresAt}','\"2000-01-01T00:00:00Z\"') WHERE id=$1",
        [op.id],
      );
      await assert.rejects(
        f.service.approve(alice, op.id, op.digest),
        /APPROVAL_INVALID/,
      );
      await f.service.cancel(alice, op.id);
      assert.equal((await f.service.submit(alice, op.id)).state, "cancelled");
    },
  );
  await t.test(
    "future schedules retained; cancellation cannot claim submitted cancelled",
    async () => {
      const d = await draft(),
        op = await f.service.prepare(
          alice,
          f.account.id,
          d.id,
          1,
          "future",
          new Date(Date.now() + 3600_000).toISOString(),
        );
      await f.service.approve(alice, op.id, op.digest);
      assert.equal((await f.service.submit(alice, op.id)).state, "approved");
      assert.equal((await f.service.cancel(alice, op.id)).state, "cancelled");
      const now = await prepared();
      await f.service.approve(alice, now.id, now.digest);
      await f.service.submit(alice, now.id);
      await assert.rejects(
        f.service.cancel(alice, now.id),
        /ALREADY_SUBMITTED/,
      );
    },
  );
  await t.test(
    "partial batch retains errors instead of silently dropping",
    async () => {
      const r = await f.service.batch(alice, f.account.id, ["m1", "missing"]);
      assert.equal(r.partial_failure, true);
      assert.equal(r.items[1]?.ok, false);
    },
  );
  await t.test(
    "attachments cannot cross accounts; body size is limited",
    async () => {
      const up = await f.service.upload(
        alice,
        f.account.id,
        "账单.txt",
        "text/plain",
        Buffer.from("invoice"),
      );
      const other = await f.service.connect(
        alice,
        {
          provider: "gmail",
          email: "test@example.com",
          oauth: { accessToken: "test" },
        },
        true,
        true,
      );
      await assert.rejects(
        f.service.createDraft(alice, other.id, {
          ...f.content,
          attachmentIds: [up.id],
        }),
        /NOT_FOUND/,
      );
      await assert.rejects(
        f.service.upload(
          alice,
          f.account.id,
          "x",
          "text/plain",
          Buffer.alloc(6 * 1024 * 1024),
        ),
        /ATTACHMENT_TOO_LARGE/,
      );
    },
  );
  await t.test(
    "reply-all filters self, deduplicates and preserves threading",
    async () => {
      f.provider.messages = [
        {
          ...message,
          to: ["test@example.com", "one@example.com"],
          cc: ["one@example.com"],
          replyTo: ["Reply Person <reply@example.com>"],
        },
      ];
      const d = await f.service.reply(
        alice,
        f.account.id,
        "m1",
        "答复",
        "reply_all",
      );
      assert.deepEqual(d.content.to, ["reply@example.com"]);
      assert.deepEqual(d.content.cc, ["one@example.com"]);
      assert.equal(d.content.inReplyTo, "<m1@example.com>");
      f.provider.messages = [message];
    },
  );
  await t.test(
    "reconciliation removes deleted cache snapshots, exposes coverage",
    async () => {
      const sync = new Synchronizer(f.service);
      await sync.run(alice, f.account.id);
      let r = await sync.search(alice, f.account.id, "发票");
      assert.equal(r.items.length, 1);
      f.provider.messages = [];
      await sync.run(alice, f.account.id);
      r = await sync.search(alice, f.account.id, "发票");
      assert.equal(r.items.length, 0);
      f.provider.messages = [message];
    },
  );
  await t.test(
    "send consent shows bound sender and inspectable byte-hashed attachment",
    async () => {
      const up = await f.service.upload(
        alice,
        f.account.id,
        "invoice<1>.txt",
        "text/plain",
        Buffer.from("consented bytes"),
      );
      const d = await f.service.createDraft(alice, f.account.id, {
        ...f.content,
        attachmentIds: [up.id],
      });
      const op = await f.service.prepare(
        alice,
        f.account.id,
        d.id,
        1,
        crypto.randomUUID(),
      );
      assert.equal(op.sender, "test@example.com");
      assert.equal(
        op.attachments[0]?.sha256,
        hash(Buffer.from("consented bytes")),
      );
      const html = approvalPage(op, "csrf");
      assert.match(html, /test@example.com/);
      assert.ok(html.includes(f.account.id));
      assert.match(html, /invoice&lt;1&gt;.txt/);
      assert.ok(html.includes(up.sha256));
      assert.ok(html.includes(`/api/uploads/${f.account.id}/${up.id}`));
      assert.notEqual(
        html,
        approvalPage(
          {
            ...op,
            accountId: crypto.randomUUID(),
            sender: "other@example.com",
          },
          "csrf",
        ),
      );
      assert.equal(
        (
          await f.service.uploaded(alice, f.account.id, up.id)
        ).content.toString(),
        "consented bytes",
      );
      await assert.rejects(
        f.service.uploaded({ ...alice, subject: "other" }, f.account.id, up.id),
        /NOT_FOUND/,
      );
    },
  );
  await t.test(
    "changed attachment bytes invalidate consent before approval and submission",
    async () => {
      for (const approved of [false, true]) {
        const up = await f.service.upload(
          alice,
          f.account.id,
          "bound.txt",
          "text/plain",
          Buffer.from("original"),
        );
        const d = await f.service.createDraft(alice, f.account.id, {
          ...f.content,
          attachmentIds: [up.id],
        });
        const op = await f.service.prepare(
          alice,
          f.account.id,
          d.id,
          1,
          crypto.randomUUID(),
        );
        if (approved) await f.service.approve(alice, op.id, op.digest);
        const blob = await f.store.get<any>(alice, f.account.id, "blob", up.id);
        await f.store.put(alice, f.account.id, "blob", up.id, {
          ...blob,
          content: Buffer.from("changed").toString("base64"),
        });
        const before = f.provider.sends;
        if (approved)
          assert.equal(
            (await f.service.submit(alice, op.id)).failure,
            "APPROVAL_BINDING_CHANGED",
          );
        else
          await assert.rejects(
            f.service.approve(alice, op.id, op.digest),
            /APPROVAL_BINDING_CHANGED/,
          );
        assert.equal(f.provider.sends, before);
      }
    },
  );
  await t.test("legacy intent and changed sender fail closed", async () => {
    const op = await prepared();
    const a = await f.store.account(alice, f.account.id);
    await f.store.updateAccount({ ...a, email: "changed@example.com" });
    await assert.rejects(
      f.service.approve(alice, op.id, op.digest),
      /APPROVAL_BINDING_CHANGED/,
    );
    await f.store.updateAccount(a);
    await f.db.query("UPDATE operations SET data=data-'sender' WHERE id=$1", [
      op.id,
    ]);
    await assert.rejects(
      f.service.approve(alice, op.id, op.digest),
      /APPROVAL_BINDING_CHANGED/,
    );
  });
  await t.test(
    "citation search preserves each mailbox's coverage and continuation",
    async () => {
      const original = f.provider.search.bind(f.provider);
      f.provider.search = async () => ({
        items: [message],
        coverage: "bounded-test",
        cursor: "next-page",
      });
      try {
        const r: any = await tools(f.service)
          .find((t) => t.name === "search")!
          .run(alice, { query: "invoice" });
        assert.equal(
          r.coverage.find((x: any) => x.account_id === f.account.id).scope,
          "bounded-test",
        );
        assert.equal(
          r.coverage.find((x: any) => x.account_id === f.account.id).cursor,
          "next-page",
        );
        assert.equal(r.truncated, true);
      } finally {
        f.provider.search = original;
      }
    },
  );
  await t.test("citation fetch retains decoding warnings", async () => {
    f.provider.messages = [
      { ...message, warnings: ["UNSUPPORTED_CHARSET:test"] },
    ];
    try {
      const source = Buffer.from(
        JSON.stringify({ account: f.account.id, message: message.id }),
      ).toString("base64url");
      const result: any = await tools(f.service)
        .find((t) => t.name === "fetch")!
        .run(alice, { id: source });
      assert.deepEqual(result.metadata.warnings, ["UNSUPPORTED_CHARSET:test"]);
    } finally {
      f.provider.messages = [message];
    }
  });
  await t.test(
    "reply/forward copies only explicitly selected original attachments",
    async () => {
      f.provider.messages = [
        {
          ...message,
          attachments: [
            {
              id: "original-file",
              name: "fixture.txt",
              type: "text/plain",
              size: 4,
            },
          ],
        },
      ];
      try {
        const plain = await f.service.reply(
          alice,
          f.account.id,
          "m1",
          "forward",
          "forward",
          ["to@example.com"],
        );
        assert.equal(plain.content.attachmentIds.length, 0);
        await assert.rejects(
          f.service.reply(
            alice,
            f.account.id,
            "m1",
            "forward",
            "forward",
            ["to@example.com"],
            ["foreign-file"],
          ),
          /NOT_FOUND/,
        );
        const d = await f.service.reply(
          alice,
          f.account.id,
          "m1",
          "forward",
          "forward",
          ["to@example.com"],
          ["original-file"],
        );
        assert.equal(d.content.attachmentIds.length, 1);
        assert.equal(
          (
            await f.service.uploaded(
              alice,
              f.account.id,
              d.content.attachmentIds[0]!,
            )
          ).content.toString(),
          "test",
        );
        const op = await f.service.prepare(
          alice,
          f.account.id,
          d.id,
          1,
          crypto.randomUUID(),
        );
        assert.equal(op.attachments[0]!.name, "fixture.txt");
      } finally {
        f.provider.messages = [message];
      }
    },
  );
  await t.test(
    "revocation between upload authorization and storage cannot reintroduce data",
    async () => {
      const a = await f.service.connect(
        alice,
        {
          provider: "gmail",
          email: "test@example.com",
          oauth: { accessToken: "lab-only" },
        },
        true,
        true,
      );
      const original = f.service.account.bind(f.service);
      let read!: () => void, release!: () => void;
      const checked = new Promise<void>((r) => {
          read = r;
        }),
        gate = new Promise<void>((r) => {
          release = r;
        });
      f.service.account = async (...args) => {
        const result = await original(...args);
        if (args[1] === a.id) {
          read();
          await gate;
        }
        return result;
      };
      try {
        const uploading = f.service.upload(
          alice,
          a.id,
          "late.txt",
          "text/plain",
          Buffer.from("late data"),
        );
        await checked;
        await f.service.revoke(alice, a.id);
        release();
        await assert.rejects(uploading, /ACCOUNT_REVOKED/);
        assert.equal(
          (
            await f.db.query("SELECT id FROM documents WHERE account_id=$1", [
              a.id,
            ])
          ).rows.length,
          0,
        );
      } finally {
        release();
        f.service.account = original;
      }
    },
  );
  await t.test(
    "shutdown does not claim another approved scheduled send",
    async () => {
      const op = await prepared();
      await f.service.approve(alice, op.id, op.digest);
      const controller = new AbortController();
      controller.abort();
      const before = f.provider.sends;
      await f.service.tick(controller.signal);
      assert.equal(f.provider.sends, before);
      assert.equal((await f.service.operation(alice, op.id)).state, "approved");
      await f.service.cancel(alice, op.id);
    },
  );
  await t.test(
    "v1 upgrade and repeated migration preserve credentials, drafts and send ledger",
    async () => {
      const d = await draft(),
        op = await f.service.prepare(
          alice,
          f.account.id,
          d.id,
          d.revision,
          crypto.randomUUID(),
        );
      const before = await f.store.account(alice, f.account.id);
      await f.db.query("DELETE FROM schema_version WHERE version=2");
      await f.db.query("DROP TABLE change_requests");
      const { migrate } = await import("../src/db.js");
      await migrate(f.db);
      await migrate(f.db);
      assert.equal(
        (await f.store.account(alice, f.account.id)).secret,
        before.secret,
      );
      assert.deepEqual(
        (await f.service.operation(alice, op.id)).content,
        op.content,
      );
      assert.equal(
        (
          await f.db.query(
            "SELECT version FROM schema_version ORDER BY version",
          )
        ).rows.length,
        2,
      );
      assert.equal(
        (await f.db.query("SELECT id FROM change_requests")).rows.length,
        0,
      );
    },
  );
  await t.test("schema newer than executable blocks rollback", async () => {
    await f.db.query("INSERT INTO schema_version VALUES(3)");
    const { migrate } = await import("../src/db.js");
    await assert.rejects(migrate(f.db), /newer/);
    await f.db.query("DELETE FROM schema_version WHERE version=3");
  });
  await t.test(
    "account revoke cancels queued sends and deletes scoped private documents",
    async () => {
      const op = await prepared();
      await f.service.approve(alice, op.id, op.digest);
      const before = f.provider.sends;
      await f.service.revoke(alice, f.account.id);
      await f.service.tick();
      assert.equal(f.provider.sends, before);
      assert.equal(
        (await f.service.operation(alice, op.id)).state,
        "cancelled",
      );
      await assert.rejects(
        f.service.get(alice, f.account.id, "m1"),
        /ACCOUNT_REVOKED/,
      );
      assert.equal(
        (
          await f.db.query("SELECT id FROM documents WHERE account_id=$1", [
            f.account.id,
          ])
        ).rows.length,
        0,
      );
    },
  );
});
