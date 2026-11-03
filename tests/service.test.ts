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
  await t.test("schema newer than executable blocks rollback", async () => {
    await f.db.query("INSERT INTO schema_version VALUES(2)");
    const { migrate } = await import("../src/db.js");
    await assert.rejects(migrate(f.db), /newer/);
    await f.db.query("DELETE FROM schema_version WHERE version=2");
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
