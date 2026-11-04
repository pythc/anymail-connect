import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { DemoProvider } from "../examples/demo/provider.js";
import { searchSchema } from "../src/domain.js";

test("demo init creates independent keys and refuses to overwrite persisted configuration", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anymail-demo-")),
    run = promisify(execFile),
    script = resolve("scripts/demo.mjs");
  try {
    await run(process.execPath, [script, "init"], { cwd });
    const dir = join(cwd, ".artifacts/demo"),
      original = await readFile(join(dir, "app.env"), "utf8"),
      realm = JSON.parse(await readFile(join(dir, "realm.json"), "utf8"));
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, "app.env"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "login.txt"))).mode & 0o777, 0o600);
    assert.equal(realm.realm, "anymail-demo");
    assert.equal(realm.users[0].id, "a5a8c029-96a0-4ea7-9449-50178ef90ed1");
    assert.equal(realm.clients[1].directAccessGrantsEnabled, false);
    assert.deepEqual(realm.clients[1].redirectUris, [
      "http://127.0.0.1:4482/callback",
    ]);
    assert.notEqual(
      realm.clients[0].secret,
      realm.users[0].credentials[0].value,
    );
    await assert.rejects(run(process.execPath, [script, "init"], { cwd }));
    assert.equal(await readFile(join(dir, "app.env"), "utf8"), original);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("demo mailbox is an isolated synthetic subset with no mutable provider state", async () => {
  const provider = new DemoProvider(),
    page = await provider.search(searchSchema.parse({ query: "invoice" }));
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.id, "invoice");
  page.items[0]!.subject = "changed";
  assert.equal((await provider.get("invoice")).subject, "Invoice demo-001");
  await assert.rejects(provider.mutate(), { code: "UNSUPPORTED_CAPABILITY" });
  assert.equal(
    (await provider.send({}, [], "intent")).providerId,
    "synthetic-no-delivery:intent",
  );
});
