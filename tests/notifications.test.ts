import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { PushService, gmailPushVerifier } from "../src/push.js";
import { ChangeQueue } from "../src/change-queue.js";
import { IdlePool } from "../src/idle.js";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { MailError, type Principal } from "../src/domain.js";
import { fixture, alice, LabProvider } from "./helpers.js";
class PushLab extends LabProvider {
  subscriptions: {
    callback: string;
    clientState: string;
    topic?: string;
    id?: string;
  }[] = [];
  stopped: string[] = [];
  watching = 0;
  async subscribe(o: {
    callback: string;
    clientState: string;
    topic?: string;
    id?: string;
  }) {
    this.subscriptions.push(o);
    return {
      id: o.id ?? crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 2 * 86400_000).toISOString(),
    };
  }
  async unsubscribe(id: string) {
    this.stopped.push(id);
  }
  async watch(_folder: string, _changed: () => void, signal: AbortSignal) {
    this.watching++;
    try {
      await new Promise<void>((r) => {
        if (signal.aborted) r();
        else signal.addEventListener("abort", () => r(), { once: true });
      });
    } finally {
      this.watching--;
    }
  }
}
const settings = () =>
  config({
    DATABASE_URL: "lab",
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    BASE_URL: "https://anymail.invalid",
    OIDC_ISSUER: "https://issuer.invalid",
    OIDC_AUDIENCE: "https://anymail.invalid/mcp",
    OIDC_CLIENT_ID: "web",
    ALLOWED_CLIENT_IDS: "mcp-test",
    GMAIL_PUSH_TOPIC: "projects/lab-project/topics/mail",
    GMAIL_PUSH_IDENTITY: "pubsub@lab-project.iam.gserviceaccount.com",
  });
async function until(fn: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await delay(10);
  }
  throw Error("Background lifecycle timeout");
}
test("authenticated push, scoped coalescing queue and renewal", async (t) => {
  const provider = new PushLab(),
    f = await fixture(provider),
    c = settings(),
    push = new PushService(f.service, c);
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const verify = gmailPushVerifier(
    c,
    createLocalJWKSet({ keys: [await exportJWK(publicKey)] }),
  );
  const sign = (extra = {}) =>
    new SignJWT({
      iss: "https://accounts.google.com",
      aud: c.BASE_URL + "/webhooks/gmail",
      sub: "pubsub-lab",
      email: c.GMAIL_PUSH_IDENTITY,
      email_verified: true,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...extra,
    })
      .setProtectedHeader({ alg: "RS256" })
      .sign(privateKey);
  const server = await app(
    f.service,
    c,
    async (token) => {
      if (token !== "lab-user") throw new MailError("AUTH_REQUIRED", 401);
      return { principal: alice, expiresAt: Date.now() + 300_000 };
    },
    undefined,
    verify,
  );
  t.after(async () => {
    await server.close();
    await f.close();
  });
  const headers = { host: "anymail.invalid", authorization: "Bearer lab-user" };
  const pending = async () =>
    (await f.db.query("SELECT id FROM change_requests")).rows.length;
  const clear = () => f.db.query("DELETE FROM change_requests");
  await t.test(
    "enable stores encrypted state, remains scoped and coalesces repeated enable",
    async () => {
      await assert.rejects(
        push.enable({ ...alice, subject: "foreign" }, f.account.id),
        /NOT_FOUND/,
      );
      const result = await push.enable(alice, f.account.id);
      assert.equal(result.status, "active");
      assert.equal(provider.subscriptions.length, 1);
      const state = provider.subscriptions[0]!.clientState;
      assert.ok(!JSON.stringify(result).includes(state));
      assert.ok(
        !JSON.stringify(
          (await f.db.query("SELECT data FROM documents WHERE kind='push'"))
            .rows,
        ).includes(state),
      );
      await push.enable(alice, f.account.id);
      assert.equal(provider.subscriptions.length, 1);
      assert.equal(await pending(), 1);
      await clear();
    },
  );
  await t.test(
    "Gmail signature, audience, issuer and service-account claims are enforced",
    async () => {
      for (const extra of [
        { email: "other@example.com" },
        { email_verified: false },
        { aud: "https://other.invalid" },
        { iss: "https://evil.invalid" },
        { exp: 1 },
      ])
        await assert.rejects(verify(await sign(extra)), /PUSH_AUTH_REQUIRED/);
      const payload = {
        message: {
          data: Buffer.from(
            JSON.stringify({
              emailAddress: "test@example.com",
              historyId: "999999999",
            }),
          ).toString("base64"),
        },
      };
      assert.equal(
        (
          await server.inject({
            method: "POST",
            url: "/webhooks/gmail",
            headers: { host: "anymail.invalid" },
            payload,
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await server.inject({
            method: "POST",
            url: "/webhooks/gmail",
            headers: {
              host: "anymail.invalid",
              authorization: "Bearer invalid",
            },
            payload,
          })
        ).statusCode,
        401,
      );
      assert.equal(await pending(), 0);
      const token = await sign();
      for (let i = 0; i < 3; i++)
        assert.equal(
          (
            await server.inject({
              method: "POST",
              url: "/webhooks/gmail",
              headers: {
                host: "anymail.invalid",
                authorization: "Bearer " + token,
              },
              payload,
            })
          ).statusCode,
          204,
        );
      assert.equal(await pending(), 1);
      await clear();
    },
  );
  await t.test(
    "Graph validates challenge and subscription-specific secret without model approval",
    async () => {
      const a = await f.service.connect(
        alice,
        {
          provider: "graph",
          email: "test@example.com",
          oauth: { accessToken: "graph-lab" },
        },
        true,
        true,
      );
      const challenge = await server.inject({
        method: "POST",
        url: "/webhooks/graph?validationToken=opaque%2Btoken",
        headers: { host: "anymail.invalid", "content-type": "text/plain" },
        payload: "",
      });
      assert.equal(challenge.statusCode, 200);
      assert.equal(challenge.body, "opaque+token");
      assert.match(challenge.headers["content-type"] as string, /text\/plain/);
      assert.equal(
        (
          await server.inject({
            method: "POST",
            url: "/api/push",
            headers: { host: "anymail.invalid" },
            payload: { account_id: a.id, action: "enable" },
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await server.inject({
            method: "POST",
            url: "/api/push",
            headers,
            payload: { account_id: a.id, action: "enable" },
          })
        ).statusCode,
        200,
      );
      await clear();
      const row = (
        await f.db.query<any>(
          "SELECT data FROM documents WHERE kind='push' AND account_id=$1",
          [a.id],
        )
      ).rows[0]!.data;
      const options = provider.subscriptions.at(-1)!;
      for (const clientState of [undefined, "wrong"]) {
        const r = await server.inject({
          method: "POST",
          url: "/webhooks/graph",
          headers: { host: "anymail.invalid" },
          payload: { value: [{ subscriptionId: row.providerId, clientState }] },
        });
        assert.equal(r.statusCode, 202);
      }
      assert.equal(await pending(), 0);
      await push.graph({
        value: [
          {
            subscriptionId: row.providerId,
            clientState: options.clientState,
            lifecycleEvent: "missed",
          },
        ],
      });
      assert.equal(await pending(), 1);
      await clear();
      const before = provider.subscriptions.length;
      await push.renew();
      assert.equal(provider.subscriptions.length, before + 1);
      assert.equal(provider.subscriptions.at(-1)?.id, row.providerId);
      await clear();
      await push.disable(alice, a.id);
      await push.graph({
        value: [
          { subscriptionId: row.providerId, clientState: options.clientState },
        ],
      });
      assert.equal(await pending(), 0);
      assert.ok(provider.stopped.includes(row.providerId));
      await assert.rejects(
        push.status({ ...alice, tenant: "foreign" }, a.id),
        /NOT_FOUND/,
      );
    },
  );
  await t.test(
    "notification arriving during sync survives the prior task's completion",
    async () => {
      const queue = new ChangeQueue(f.service),
        search = provider.search.bind(provider);
      let once = true;
      provider.search = async () => {
        if (once) {
          once = false;
          await queue.enqueue({
            ...f.account,
            tenant: alice.tenant,
            owner: alice.subject,
          });
        }
        return search();
      };
      try {
        await queue.enqueue({
          ...f.account,
          tenant: alice.tenant,
          owner: alice.subject,
        });
        await queue.drain();
        assert.equal(await pending(), 1);
        await queue.drain();
        assert.equal(await pending(), 0);
      } finally {
        provider.search = search;
      }
    },
  );
  await t.test(
    "an expired registration lease cannot overwrite a newer subscription",
    async () => {
      const a = await f.service.connect(
        alice,
        {
          provider: "graph",
          email: "test@example.com",
          oauth: { accessToken: "lease-lab" },
        },
        true,
        true,
      );
      const original = provider.subscribe.bind(provider);
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((r) => {
          entered = r;
        }),
        gate = new Promise<void>((r) => {
          release = r;
        });
      let count = 0;
      provider.subscribe = async (o) => {
        if (count++ === 0) {
          entered();
          await gate;
        }
        return original(o);
      };
      try {
        const first = push.enable(alice, a.id),
          rejected = assert.rejects(first, /PUSH_LEASE_LOST/);
        await started;
        await f.db.query(
          "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
          ["push-lease:" + a.id],
        );
        await push.enable(alice, a.id);
        const before = (
          await f.db.query<any>(
            "SELECT data FROM documents WHERE account_id=$1 AND kind='push'",
            [a.id],
          )
        ).rows[0]!.data;
        release();
        await rejected;
        const after = (
          await f.db.query<any>(
            "SELECT data FROM documents WHERE account_id=$1 AND kind='push'",
            [a.id],
          )
        ).rows[0]!.data;
        assert.equal(after.status, "active");
        assert.equal(after.generation, before.generation);
        assert.equal(after.providerId, before.providerId);
        await push.disable(alice, a.id);
        await clear();
      } finally {
        release();
        provider.subscribe = original;
      }
    },
  );
  await t.test(
    "shutdown preserves queued changes instead of starting another sync",
    async () => {
      const queue = new ChangeQueue(f.service);
      await queue.enqueue({
        ...f.account,
        tenant: alice.tenant,
        owner: alice.subject,
      });
      const controller = new AbortController();
      controller.abort();
      assert.equal(await queue.drain(20, controller.signal), 0);
      assert.equal(await pending(), 1);
      await clear();
    },
  );
  await t.test(
    "batch notification coalescing preserves folder and tenant boundaries",
    async () => {
      const queue = new ChangeQueue(f.service),
        account = { ...f.account, tenant: alice.tenant, owner: alice.subject };
      await queue.enqueueMany([
        { ...account, folder: "INBOX" },
        { ...account, folder: "INBOX" },
        { ...account, folder: "Archive" },
        { ...account, folder: "foreign", tenant: "other" },
      ]);
      const rows = await f.db.query<{ folder: string; tenant: string }>(
        "SELECT folder,tenant FROM change_requests ORDER BY folder",
      );
      assert.deepEqual(
        rows.rows.map((x) => x.folder),
        ["Archive", "INBOX"],
      );
      assert.ok(rows.rows.every((x) => x.tenant === alice.tenant));
      await clear();
    },
  );
  await t.test("revoked watch cannot enqueue new work", async () => {
    await f.service.revoke(alice, f.account.id);
    await push.gmail({
      message: {
        data: Buffer.from(
          JSON.stringify({
            emailAddress: "test@example.com",
            historyId: "123",
          }),
        ).toString("base64"),
      },
    });
    await new ChangeQueue(f.service).enqueue({
      ...f.account,
      tenant: alice.tenant,
      owner: alice.subject,
    });
    assert.equal(await pending(), 0);
  });
});
test("bounded IDLE pool: cross-worker lease, revocation and shutdown", async (t) => {
  const provider = new PushLab(),
    f = await fixture(provider);
  const accounts = [];
  for (let i = 0; i < 2; i++)
    accounts.push(
      await f.service.connect(
        alice,
        {
          provider: "imap",
          email: "test@example.com",
          username: "lab",
          password: "lab",
          imap: { host: "lab.invalid", port: 993, secure: true },
          smtp: { host: "lab.invalid", port: 465, secure: true },
        },
        false,
        false,
      ),
    );
  const one = new IdlePool(f.service, 2),
    two = new IdlePool(f.service, 2);
  t.after(async () => {
    await one.close();
    await two.close();
    await f.close();
  });
  await one.tick();
  await until(() => provider.watching === 2);
  assert.equal(one.size, 2);
  await two.tick();
  assert.equal(two.size, 0);
  assert.equal(provider.watching, 2);
  await f.service.revoke(alice, accounts[0]!.id);
  await one.tick();
  await until(() => one.size === 1);
  assert.equal(provider.watching, 1);
  await one.close();
  assert.equal(provider.watching, 0);
  assert.equal(
    (await f.db.query("SELECT id FROM sessions WHERE id LIKE 'idle:%'")).rows
      .length,
    0,
  );
  await two.tick();
  await two.tick();
  await until(() => two.size === 1 && provider.watching === 1);
  assert.equal(provider.watching, 1);
});
