import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT, generateKeyPair, createLocalJWKSet, exportJWK } from "jose";
import { fixture, alice, LabProvider, message } from "./helpers.js";
import { Vault } from "../src/crypto.js";
import { rotateKeys, retain } from "../src/maintenance.js";
import { NativeDrafts } from "../src/native-drafts.js";
import { verifier } from "../src/auth.js";
import { tools } from "../src/tools.js";
import type { DraftContent, Message } from "../src/domain.js";
import { migrate } from "../src/db.js";
import { migrate as legacyMigrate } from "./fixtures/legacy-v2-db.js";
const member = { ...alice, subject: "bob" };
test("v2 upgrade preserves legacy ciphertext and the original old migration rejects schema3", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const a = await f.store.account(alice, f.account.id),
    context = `${a.tenant}:${a.owner}:${a.id}`;
  a.secret = a.secret.split(".")[2]!;
  await f.store.updateAccount(a);
  const d = await f.service.createDraft(alice, a.id, f.content),
    op = await f.service.prepare(
      alice,
      a.id,
      d.id,
      d.revision,
      "schema-upgrade",
    );
  await f.db.query("DELETE FROM schema_version WHERE version=3");
  await f.db.query("DROP TABLE account_grants");
  await migrate(f.db);
  await migrate(f.db);
  assert.equal(
    f.vault.open<any>((await f.store.account(alice, a.id)).secret, context)
      .provider,
    "gmail",
  );
  assert.deepEqual(
    (await f.service.operation(alice, op.id)).content,
    op.content,
  );
  await assert.rejects(legacyMigrate(f.db), /newer/);
  assert.equal(
    (await f.db.query("SELECT version FROM schema_version")).rows.length,
    3,
  );
});
test("same-tenant shared credential grants and actor-private data", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const expiry = new Date(Date.now() + 3600_000).toISOString();
  await t.test(
    "read grant does not confer write/send or connection management",
    async () => {
      await f.service.grant(
        alice,
        f.account.id,
        member.subject,
        ["mail.read"],
        expiry,
      );
      assert.equal((await f.store.accounts(member)).length, 1);
      assert.equal((await f.service.get(member, f.account.id, "m1")).id, "m1");
      await assert.rejects(
        f.service.createDraft(member, f.account.id, f.content),
        /PERMISSION_DENIED/,
      );
      await assert.rejects(
        f.service.get({ ...member, tenant: "other" }, f.account.id, "m1"),
        /NOT_FOUND/,
      );
      await assert.rejects(
        f.service.grant(member, f.account.id, "mallory", ["mail.read"], expiry),
        /OWNER_REQUIRED/,
      );
      await assert.rejects(
        f.service.revoke(member, f.account.id),
        /OWNER_REQUIRED/,
      );
    },
  );
  await t.test(
    "member drafts are private and revoked sends never reach provider",
    async () => {
      await f.service.grant(
        alice,
        f.account.id,
        member.subject,
        member.scopes,
        expiry,
      );
      const d = await f.service.createDraft(member, f.account.id, f.content);
      await assert.rejects(
        f.store.get(alice, f.account.id, "draft", d.id),
        /NOT_FOUND/,
      );
      const op = await f.service.prepare(
        member,
        f.account.id,
        d.id,
        d.revision,
        "shared-send",
      );
      await f.service.approve(member, op.id, op.digest);
      await f.service.revokeGrant(alice, f.account.id, member.subject);
      assert.equal(
        (await f.service.operation(member, op.id)).state,
        "cancelled",
      );
      await f.service.tick();
      assert.equal(f.provider.sends, 0);
      await assert.rejects(
        f.service.get(member, f.account.id, "m1"),
        /NOT_FOUND/,
      );
      await assert.rejects(
        f.store.get(member, f.account.id, "draft", d.id),
        /NOT_FOUND/,
      );
    },
  );
  await t.test(
    "expired grants fail closed and owner revocation cancels all actors",
    async () => {
      await f.service.grant(
        alice,
        f.account.id,
        member.subject,
        member.scopes,
        expiry,
      );
      await f.db.query(
        "UPDATE account_grants SET expires_at=now()-interval '1 second'",
      );
      await assert.rejects(
        f.service.account(member, f.account.id),
        /NOT_FOUND/,
      );
      await f.service.grant(
        alice,
        f.account.id,
        member.subject,
        member.scopes,
        expiry,
      );
      const d = await f.service.createDraft(member, f.account.id, f.content),
        op = await f.service.prepare(
          member,
          f.account.id,
          d.id,
          d.revision,
          "revoke-all",
        );
      await f.service.approve(member, op.id, op.digest);
      await f.service.revoke(alice, f.account.id);
      assert.equal(
        (await f.service.operation(member, op.id)).state,
        "cancelled",
      );
      assert.equal(
        (await f.db.query("SELECT id FROM documents")).rows.length,
        0,
      );
    },
  );
});
test("key ring rotation preserves credentials, push and web sessions", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const old = Buffer.alloc(32, 7).toString("base64"),
    next = Buffer.alloc(32, 8).toString("base64");
  const legacy = f.vault.seal({ password: "synthetic" }, "old").split(".")[2]!;
  const vault = new Vault(next, "next", { primary: old });
  assert.equal(vault.open<any>(legacy, "old").password, "synthetic");
  assert.throws(() => vault.open(legacy, "other"), /DECRYPTION/);
  const a = await f.store.account(alice, f.account.id),
    pushId = crypto.randomUUID(),
    ctx = `push:${a.tenant}:${a.owner}:${a.id}`;
  await f.store.put(alice, a.id, "push", pushId, {
    sealed: f.vault.seal({ clientState: "fixture" }, ctx),
  });
  await f.store.setSession(
    "web:fixture",
    { sealed: f.vault.seal({ token: "synthetic" }, "web:fixture") },
    new Date(Date.now() + 60_000).toISOString(),
  );
  f.service.vault = vault;
  assert.deepEqual(await rotateKeys(f.service), {
    apply: false,
    accounts: 1,
    push: 1,
    sessions: 1,
  });
  assert.equal((await f.store.account(alice, a.id)).secret, a.secret);
  assert.deepEqual(await rotateKeys(f.service, true), {
    apply: true,
    accounts: 1,
    push: 1,
    sessions: 1,
  });
  const only = new Vault(next, "next");
  assert.equal(
    only.open<any>(
      (await f.store.account(alice, a.id)).secret,
      `${a.tenant}:${a.owner}:${a.id}`,
    ).provider,
    "gmail",
  );
  const p = await f.store.get<any>(alice, a.id, "push", pushId);
  assert.equal(only.open<any>(p.sealed, ctx).clientState, "fixture");
  assert.equal(
    only.open<any>(
      (await f.store.session<any>("web:fixture"))!.sealed,
      "web:fixture",
    ).token,
    "synthetic",
  );
  assert.deepEqual(await rotateKeys(f.service, true), {
    apply: true,
    accounts: 0,
    push: 0,
    sessions: 0,
  });
});
test("retention preserves active send references and all dedupe ledger", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const b = await f.service.upload(
      alice,
      f.account.id,
      "a.txt",
      "text/plain",
      Buffer.from("bytes"),
    ),
    d = await f.service.createDraft(alice, f.account.id, {
      ...f.content,
      attachmentIds: [b.id],
    });
  await f.service.prepare(
    alice,
    f.account.id,
    d.id,
    d.revision,
    "durable-ledger",
  );
  const old = new Date(0).toISOString();
  await f.db.query(
    "UPDATE documents SET data=jsonb_set(jsonb_set(data,'{updatedAt}',$1::jsonb),'{createdAt}',$1::jsonb) WHERE kind IN ('blob','draft')",
    [JSON.stringify(old)],
  );
  await f.store.put(alice, f.account.id, "cache", crypto.randomUUID(), {
    _observedAt: old,
    text: "expired",
  });
  await f.store.put(
    alice,
    f.account.id,
    "attachment_index",
    crypto.randomUUID(),
    { indexedAt: old, text: "expired" },
  );
  const r = await retain(f.service, {
    RETENTION_CACHE_DAYS: 30,
    RETENTION_DRAFT_DAYS: 90,
    RETENTION_AUDIT_DAYS: 180,
  });
  assert.equal(r.deleted, 2);
  assert.equal(
    (await f.store.get<any>(alice, f.account.id, "draft", d.id)).id,
    d.id,
  );
  assert.equal(
    (await f.store.get<any>(alice, f.account.id, "blob", b.id)).id,
    b.id,
  );
  assert.equal((await f.db.query("SELECT id FROM operations")).rows.length, 1);
});
test("JWT introspection rejects inactive/mismatched identity and intersects scopes", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256"),
    key = createLocalJWKSet({ keys: [await exportJWK(publicKey)] });
  const token = await new SignJWT({
    tenant_id: "personal",
    azp: "client",
    scope: "mail.read mail.write",
  })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject("alice")
    .setIssuedAt()
    .setExpirationTime("5m")
    .setIssuer("https://issuer.invalid")
    .setAudience("resource")
    .sign(privateKey);
  let state: any = { active: true, scope: "mail.read" };
  const verify = verifier(
    "https://issuer.invalid",
    "resource",
    ["client"],
    key,
    async () => state,
  );
  assert.deepEqual((await verify(token)).principal.scopes, ["mail.read"]);
  state = { active: true, scope: "" };
  assert.deepEqual((await verify(token)).principal.scopes, []);
  state = { active: false };
  await assert.rejects(verify(token), /AUTH_REQUIRED/);
  state = { active: true, sub: "other" };
  await assert.rejects(verify(token), /AUTH_REQUIRED/);
  state = { active: true, exp: 0 };
  await assert.rejects(verify(token), /AUTH_REQUIRED/);
  const offline = verifier(
    "https://issuer.invalid",
    "resource",
    ["client"],
    key,
    async () => {
      throw Error("offline");
    },
  );
  await assert.rejects(offline(token), {
    code: "AUTH_SERVICE_UNAVAILABLE",
    status: 503,
  });
});
class NativeLab extends LabProvider {
  remote = {
    to: ["recipient@example.com"],
    cc: [],
    bcc: ["private@example.com"],
    subject: "remote",
    text: "body",
    attachmentIds: [],
    references: [],
  };
  version = 1;
  writes = 0;
  fail = false;
  async nativeDraft(): Promise<{
    version: string;
    content: DraftContent;
    message: Message;
  }> {
    return {
      version: String(this.version),
      content: structuredClone(this.remote),
      message: { ...message, attachments: [] },
    };
  }
  async updateNativeDraft(_id: string, version: string, content: any) {
    assert.equal(version, String(this.version));
    this.writes++;
    this.remote = structuredClone(content);
    this.version++;
    if (this.fail) throw Error("lost response");
  }
}
test("Graph native attachment edits are read back by byte identity; large files fail before writes", async (t) => {
  class GraphLab extends NativeLab {
    files: { filename: string; contentType: string; content: Buffer }[] = [];
    override async nativeDraft() {
      const r = await super.nativeDraft();
      return {
        ...r,
        message: {
          ...r.message,
          attachments: this.files.map((f, n) => ({
            id: String(n),
            name: f.filename,
            type: f.contentType,
            size: f.content.length,
          })),
        },
      };
    }
    override async updateNativeDraft(
      id: string,
      version: string,
      content: any,
      _files?: any[],
      replace?: boolean,
    ) {
      await super.updateNativeDraft(id, version, content);
      if (replace)
        this.files = structuredClone(_files!).map((f: any) => ({
          ...f,
          content: Buffer.from(f.content),
        }));
    }
    override async attachment(_message?: string, id?: string) {
      const f = this.files[Number(id)]!;
      return {
        content: Buffer.from(f.content),
        type: f.contentType,
        name: f.filename,
      };
    }
  }
  const p = new GraphLab(),
    f = await fixture(p);
  t.after(f.close);
  const a = await f.service.connect(
      alice,
      {
        provider: "graph",
        email: "test@example.com",
        oauth: { accessToken: "synthetic" },
      },
      true,
      true,
    ),
    native = new NativeDrafts(f.service),
    b = await native.bind(alice, a.id, "native", true);
  const small = await f.service.upload(
    alice,
    a.id,
    "note.txt",
    "text/plain",
    Buffer.from("new bytes"),
  );
  const d = await f.service.updateDraft(alice, a.id, b.draft.id, 1, {
    ...b.draft.content,
    attachmentIds: [small.id],
  });
  assert.equal((await native.sync(alice, a.id, b.binding.id)).status, "clean");
  assert.equal(p.files[0]!.content.toString(), "new bytes");
  const large = await f.service.upload(
    alice,
    a.id,
    "large.bin",
    "application/octet-stream",
    Buffer.alloc(3_000_000),
  );
  await f.service.updateDraft(alice, a.id, d.id, d.revision, {
    ...d.content,
    attachmentIds: [large.id],
  });
  const before = p.writes;
  assert.equal(
    (await native.sync(alice, a.id, b.binding.id)).error,
    "NATIVE_ATTACHMENT_REQUIRES_UPLOAD_SESSION",
  );
  assert.equal(p.writes, before);
});
test("grant downgrade and expiry cannot reactivate old send approvals", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const expires = new Date(Date.now() + 60_000).toISOString();
  await f.service.grant(
    alice,
    f.account.id,
    member.subject,
    member.scopes,
    expires,
  );
  const d = await f.service.createDraft(member, f.account.id, f.content),
    op = await f.service.prepare(
      member,
      f.account.id,
      d.id,
      d.revision,
      "downgrade",
    );
  await f.service.approve(member, op.id, op.digest);
  await f.service.grant(
    alice,
    f.account.id,
    member.subject,
    ["mail.read"],
    expires,
  );
  await f.service.grant(
    alice,
    f.account.id,
    member.subject,
    member.scopes,
    expires,
  );
  assert.equal((await f.service.operation(member, op.id)).state, "cancelled");
  const other = await f.service.prepare(
    member,
    f.account.id,
    d.id,
    d.revision,
    "expired",
  );
  await f.service.approve(member, other.id, other.digest);
  await f.db.query(
    "UPDATE account_grants SET expires_at=now()-interval '1 second'",
  );
  await f.service.grant(
    alice,
    f.account.id,
    member.subject,
    member.scopes,
    expires,
  );
  assert.equal(
    (await f.service.operation(member, other.id)).state,
    "cancelled",
  );
  await assert.rejects(
    f.service.revokeGrant(alice, f.account.id, alice.subject),
    /INVALID_GRANT/,
  );
  await f.service.tick();
  assert.equal(f.provider.sends, 0);
});
test("grant revocation during prepare cannot recreate an operation afterward", async (t) => {
  const f = await fixture();
  t.after(f.close);
  await f.service.grant(
    alice,
    f.account.id,
    member.subject,
    member.scopes,
    new Date(Date.now() + 60_000).toISOString(),
  );
  const d = await f.service.createDraft(member, f.account.id, f.content),
    get = f.store.get.bind(f.store);
  let entered!: () => void,
    release!: () => void,
    once = true;
  const started = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  t.after(() => release());
  f.store.get = (async (...args: Parameters<typeof get>) => {
    const result = await get(...args);
    if (once && args[2] === "draft") {
      once = false;
      entered();
      await gate;
    }
    return result;
  }) as typeof f.store.get;
  const preparing = f.service.prepare(
      member,
      f.account.id,
      d.id,
      d.revision,
      "revoked-prepare",
    ),
    refused = assert.rejects(preparing, /NOT_FOUND/);
  await started;
  await f.service.revokeGrant(alice, f.account.id, member.subject);
  release();
  await refused;
  assert.equal((await f.db.query("SELECT id FROM operations")).rows.length, 0);
});
test("stopping a native link fences in-flight push and pull", async (t) => {
  const p = new NativeLab(),
    f = await fixture(p);
  t.after(f.close);
  const native = new NativeDrafts(f.service),
    first = await native.bind(alice, f.account.id, "native1", true);
  await f.service.updateDraft(alice, f.account.id, first.draft.id, 1, {
    ...first.draft.content,
    text: "push",
  });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const update = p.updateNativeDraft.bind(p);
  p.updateNativeDraft = async (...args) => {
    entered();
    await gate;
    await update(...args);
  };
  const pushing = native.sync(alice, f.account.id, first.binding.id),
    rejected = assert.rejects(pushing, /NATIVE_LINK_STOPPED/);
  await started;
  await native.stop(alice, f.account.id, first.binding.id);
  release();
  await rejected;
  assert.equal(
    (
      await f.store.get<any>(
        alice,
        f.account.id,
        "native_binding",
        first.binding.id,
      )
    ).enabled,
    false,
  );
  const second = await native.bind(alice, f.account.id, "native2", true),
    before = second.draft.content.text;
  p.remote.text = "remote changes after stop";
  p.version++;
  let readEntered!: () => void, readRelease!: () => void;
  const readStarted = new Promise<void>((r) => {
      readEntered = r;
    }),
    readGate = new Promise<void>((r) => {
      readRelease = r;
    }),
    read = p.nativeDraft.bind(p);
  p.nativeDraft = async () => {
    const r = await read();
    readEntered();
    await readGate;
    return r;
  };
  const pulling = native.sync(alice, f.account.id, second.binding.id),
    refused = assert.rejects(pulling, /NATIVE_LINK_STOPPED/);
  await readStarted;
  await native.stop(alice, f.account.id, second.binding.id);
  readRelease();
  await refused;
  assert.equal(
    (await f.store.get<any>(alice, f.account.id, "draft", second.draft.id))
      .content.text,
    before,
  );
});
test("continuous native draft sync: pull/push/conflicts and unknown results", async (t) => {
  const provider = new NativeLab(),
    f = await fixture(provider);
  t.after(f.close);
  const native = new NativeDrafts(f.service);
  const linked = await native.bind(alice, f.account.id, "native-id", true),
    b = linked.binding;
  assert.deepEqual(linked.draft.content.bcc, ["private@example.com"]);
  let d = await f.service.updateDraft(alice, f.account.id, b.draftId, 1, {
    ...linked.draft.content,
    text: "local",
  });
  assert.equal((await native.sync(alice, f.account.id, b.id)).status, "clean");
  assert.equal(provider.remote.text, "local");
  provider.remote.text = "provider-edit";
  provider.version++;
  await f.db.query(
    "UPDATE documents SET data=jsonb_set(data,'{nextCheck}',$1::jsonb) WHERE kind='native_binding'",
    [JSON.stringify(new Date(0).toISOString())],
  );
  await native.tick();
  d = await f.store.get(alice, f.account.id, "draft", b.draftId);
  assert.equal(d.content.text, "provider-edit");
  d = await f.service.updateDraft(alice, f.account.id, b.draftId, d.revision, {
    ...d.content,
    text: "local-again",
  });
  provider.remote.text = "remote-again";
  provider.version++;
  assert.equal(
    (await native.sync(alice, f.account.id, b.id)).status,
    "conflict",
  );
  await assert.rejects(
    native.sync(alice, f.account.id, b.id, "pull", d.revision, "stale"),
    /REVISION_CONFLICT/,
  );
  await native.sync(
    alice,
    f.account.id,
    b.id,
    "pull",
    d.revision,
    String(provider.version),
  );
  d = await f.store.get(alice, f.account.id, "draft", b.draftId);
  assert.equal(d.content.text, "remote-again");
  await f.service.updateDraft(alice, f.account.id, b.draftId, d.revision, {
    ...d.content,
    text: "ambiguous",
  });
  provider.fail = true;
  assert.equal(
    (await native.sync(alice, f.account.id, b.id)).status,
    "unknown",
  );
  const before = provider.writes;
  await native.tick();
  await native.sync(alice, f.account.id, b.id);
  assert.equal(provider.writes, before);
  const all = tools(f.service),
    index = all.find((t) => t.name === "attachments_index")!,
    search = all.find((t) => t.name === "attachments_search")!;
  provider.attachment = async () => ({
    content: Buffer.from("发票金额 100"),
    type: "text/plain",
    name: "invoice.txt",
  });
  await index.run(alice, {
    account_id: f.account.id,
    message_id: "m1",
    attachment_id: "a",
  });
  assert.equal(
    (
      (await search.run(alice, {
        account_id: f.account.id,
        query: "发票",
        offset: 0,
      })) as any
    ).items.length,
    1,
  );
  await f.service.grant(
    alice,
    f.account.id,
    member.subject,
    ["mail.read"],
    new Date(Date.now() + 60_000).toISOString(),
  );
  assert.equal(
    (
      (await search.run(member, {
        account_id: f.account.id,
        query: "发票",
        offset: 0,
      })) as any
    ).items.length,
    0,
  );
  await assert.rejects(
    all
      .find((t) => t.name === "attachments_import_file")!
      .run(alice, {
        account_id: f.account.id,
        file: { download_url: "https://evil.invalid/", file_id: "synthetic" },
      }),
    /HOST_FILE_ORIGIN_DENIED/,
  );
});

test("native conflict inspection refreshes versions without clearing unknown or writing", async (t) => {
  const provider = new NativeLab(),
    f = await fixture(provider);
  t.after(f.close);
  const native = new NativeDrafts(f.service),
    linked = await native.bind(alice, f.account.id, "native", true);
  await f.service.updateDraft(alice, f.account.id, linked.draft.id, 1, {
    ...linked.draft.content,
    text: "local-change",
  });
  provider.fail = true;
  assert.equal(
    (await native.sync(alice, f.account.id, linked.binding.id)).status,
    "unknown",
  );
  provider.remote.text = "later-remote";
  provider.version++;
  const before = provider.writes,
    current = await native.inspect(alice, f.account.id, linked.binding.id);
  assert.equal(current.binding.status, "unknown");
  assert.equal(current.remote.version, String(provider.version));
  assert.equal(current.remote.content.text, "later-remote");
  assert.equal(provider.writes, before);
  await native.sync(
    alice,
    f.account.id,
    linked.binding.id,
    "pull",
    current.draft.revision,
    current.remote.version,
  );
  assert.equal(
    (await f.store.get<any>(alice, f.account.id, "draft", linked.draft.id))
      .content.text,
    "later-remote",
  );
  assert.equal(provider.writes, before);
});
