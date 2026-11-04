import test from "node:test";
import assert from "node:assert/strict";
import { CardDav, people } from "../src/providers/contacts.js";
import { EwsProvider } from "../src/providers/ews.js";
import { Rest, cursorEncode } from "../src/providers/rest.js";
import { parseXml } from "../src/providers/xml.js";
import { draftSchema, searchSchema } from "../src/domain.js";
import { GraphProvider } from "../src/providers/graph.js";
import { GmailProvider } from "../src/providers/gmail.js";
import type { HttpRequest } from "../src/network.js";
const response = (body: unknown, status = 200, headers = {}) => ({
  status,
  headers,
  body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
});
test("People contacts map paging, structured fields and concurrency metadata", async () => {
  const calls: any[] = [],
    p = {
      resourceName: "people/c1",
      etag: "etag1",
      names: [{ displayName: "张三" }],
      emailAddresses: [{ value: "contact@example.com" }],
      metadata: { sources: [{ type: "CONTACT", id: "c1", etag: "source1" }] },
    };
  const api = new Rest(
    "https://people.googleapis.com/v1",
    async () => "synthetic",
    async (url, o) => {
      calls.push({ url, ...o });
      return response(
        url.includes("connections")
          ? { connections: [p], nextPageToken: "page2" }
          : p,
      );
    },
  );
  const list: any = await people(api, "contacts.list", { cursor: "page1" });
  assert.equal(list.items[0].displayName, "张三");
  assert.equal(list.cursor, "page2");
  assert.match(calls[0].url, /personFields=.*metadata/);
  await people(api, "contacts.update", {
    id: "people/c1",
    etag: "etag1",
    contact: {
      givenName: "李",
      emailAddresses: [{ address: "new@example.com" }],
    },
  });
  const body = JSON.parse(calls.at(-1).body);
  assert.equal(body.metadata.sources[0].etag, "source1");
  assert.equal(body.emailAddresses[0].value, "new@example.com");
  await assert.rejects(
    people(api, "contacts.update", {
      id: "people/c1",
      etag: "stale",
      contact: {},
    }),
    /REVISION_CONFLICT/,
  );
  await assert.rejects(
    people(api, "contacts.get", { id: "people/../token" }),
    /INVALID_CONTACT/,
  );
});
test("CardDAV href confinement, ETag writes and XML limits", async () => {
  let hostile = false,
    last: any;
  const vcard =
    "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:keep-id\r\nFN:张三\r\nitem1.EMAIL:contact@example.com\r\nX-CUSTOM:retain\r\nEND:VCARD\r\n";
  const http: HttpRequest = async (url, o) => {
    last = { url, ...o };
    if (o?.method === "REPORT")
      return response(
        `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:response><d:href>${hostile ? "https://evil.invalid/a.vcf" : "/book/a.vcf"}</d:href><d:propstat><d:prop><d:getetag>etag1</d:getetag><c:address-data>${vcard}</c:address-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
        207,
      );
    if (o?.method === "GET") return response(vcard, 200, { etag: "etag1" });
    return response("", 204, { etag: "etag2" });
  };
  const dav = new CardDav(
    {
      url: "https://dav.invalid/book/",
      username: "synthetic",
      password: "synthetic",
    },
    http,
  );
  const list: any = await dav.run("contacts.list", {});
  assert.equal(list.items[0].displayName, "张三");
  assert.equal(list.items[0].id, "a.vcf");
  assert.equal(list.items[0].emailAddresses[0].address, "contact@example.com");
  await dav.run("contacts.update", {
    id: "a.vcf",
    etag: "etag1",
    contact: {
      displayName: "New\nINJECT",
      emailAddresses: [{ address: "new@example.com" }],
    },
  });
  assert.equal(last.headers["if-match"], "etag1");
  assert.match(last.body, /X-CUSTOM:retain/);
  assert.match(last.body, /FN:New\\nINJECT/);
  assert.match(last.body, /UID:keep-id/);
  await assert.rejects(
    dav.run("contacts.delete", { id: "../a.vcf", etag: "etag1" }),
    /INVALID_CONTACT/,
  );
  await assert.rejects(
    dav.run("contacts.update", { id: "a.vcf", etag: "stale", contact: {} }),
    /REVISION_CONFLICT/,
  );
  hostile = true;
  await assert.rejects(dav.run("contacts.list", {}), /ORIGIN_DENIED/);
  assert.throws(
    () => parseXml('<!DOCTYPE x [<!ENTITY e "test">]><x>&e;</x>'),
    /INVALID_XML/,
  );
  assert.throws(
    () => parseXml("<x>".repeat(65) + "</x>".repeat(65)),
    /XML_LIMIT/,
  );
});
const envelope = (op: string, body: string, code = "NoError") =>
  `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><s:Body><m:${op}Response><m:ResponseMessages><m:${op}ResponseMessage ResponseClass="Success"><m:ResponseCode>${code}</m:ResponseCode>${body}</m:${op}ResponseMessage></m:ResponseMessages></m:${op}Response></s:Body></s:Envelope>`;
test("on-prem EWS SOAP stays at configured TLS origin, scopes mailbox and never overwrites stale changes", async () => {
  const calls: any[] = [];
  let conflict = false;
  const http: HttpRequest = async (url, o) => {
    calls.push({ url, ...o });
    const op = String(o?.headers?.SOAPAction)
      .split("/")
      .at(-1)!
      .replaceAll('"', "");
    const body =
      op === "FindItem"
        ? '<m:RootFolder IncludesLastItemInRange="true"><t:Items><t:Message><t:ItemId Id="item1" ChangeKey="v1"/><t:Subject>合同</t:Subject><t:IsRead>false</t:IsRead></t:Message></t:Items></m:RootFolder>'
        : op === "GetItem"
          ? `<m:Items><t:Message><t:ItemId Id="item1" ChangeKey="v1"/><t:Subject>合同</t:Subject><t:MimeContent>${Buffer.from("From: sender@example.com\r\nTo: recipient@example.com\r\nSubject: Contract\r\n\r\nSynthetic EWS content").toString("base64")}</t:MimeContent></t:Message></m:Items>`
          : "";
    return response(
      envelope(op, body, conflict ? "ErrorIrresolvableConflict" : "NoError"),
    );
  };
  const config = {
      provider: "ews" as const,
      email: "enterprise@example.com",
      url: "https://exchange.invalid/EWS/Exchange.asmx",
      auth: { type: "basic" as const, username: "user", password: "synthetic" },
    },
    provider = new EwsProvider(config, http, ["https://exchange.invalid"]);
  assert.throws(() => new EwsProvider(config, http, []), /ORIGIN_DENIED/);
  await provider.verify();
  assert.match(calls[0].body, /<t:EmailAddress>enterprise@example.com/);
  assert.equal(
    calls[0].headers.authorization,
    "Basic " + Buffer.from("user:synthetic").toString("base64"),
  );
  const page = await provider.search(searchSchema.parse({ subject: 'A<&"' }));
  assert.match(calls.at(-1).body, /A&lt;&amp;&quot;/);
  assert.equal(page.items[0]!.subject, "合同");
  const m = await provider.get(page.items[0]!.id);
  assert.match(m.text, /Synthetic EWS content/);
  await provider.mutate(m.id, { action: "read" });
  assert.match(calls.at(-1).body, /ConflictResolution="NeverOverwrite"/);
  assert.match(calls.at(-1).body, /ChangeKey="v1"/);
  await provider.send(
    draftSchema.parse({
      to: ["recipient@example.com"],
      subject: "Test",
      text: "Body",
    }),
    [],
    "intent",
  );
  assert.match(calls.at(-1).body, /MessageDisposition="SendAndSaveCopy"/);
  assert.ok(calls.every((c) => c.url === config.url));
  conflict = true;
  await assert.rejects(
    provider.mutate(m.id, { action: "read" }),
    /REVISION_CONFLICT/,
  );
});
test("native draft provider writes check draft status/version and carry Bcc", async () => {
  const calls: any[] = [];
  let fail = false;
  const graph = new GraphProvider(
    new Rest(
      "https://graph.microsoft.com/v1.0",
      async () => "synthetic",
      async (url, o) => {
        calls.push({ url, ...o });
        if (o?.method === "PATCH" && fail) return response({}, 412);
        return response({
          id: "d1",
          isDraft: true,
          "@odata.etag": 'W/"v1"',
          subject: "Draft",
          body: { contentType: "text", content: "body" },
          toRecipients: [{ emailAddress: { address: "to@example.com" } }],
          bccRecipients: [{ emailAddress: { address: "bcc@example.com" } }],
          attachments: [
            {
              id: "old-file",
              name: "old.txt",
              contentType: "text/plain",
              size: 3,
            },
          ],
        });
      },
    ),
  );
  const r = await graph.nativeDraft("d1");
  assert.deepEqual(r.content.bcc, ["bcc@example.com"]);
  fail = true;
  await assert.rejects(
    graph.updateNativeDraft("d1", r.version, r.content, []),
    /REVISION_CONFLICT/,
  );
  assert.equal(calls.at(-1).headers["If-Match"], r.version);
  fail = false;
  await graph.updateNativeDraft(
    "d1",
    r.version,
    r.content,
    [
      {
        filename: "new.txt",
        contentType: "text/plain",
        content: Buffer.from("new"),
      },
    ],
    true,
  );
  assert.ok(
    calls.some(
      (c) => c.method === "DELETE" && c.url.endsWith("/attachments/old-file"),
    ),
  );
  assert.equal(
    JSON.parse(calls.at(-1).body).contentBytes,
    Buffer.from("new").toString("base64"),
  );
  let version = "message1";
  const gmail = new GmailProvider(
    new Rest(
      "https://gmail.googleapis.com/gmail/v1",
      async () => "synthetic",
      async (url, o) => {
        calls.push({ url, ...o });
        return response({
          id: "d1",
          message: {
            id: version,
            payload: {
              headers: [
                { name: "Subject", value: "Draft" },
                { name: "To", value: "to@example.com" },
                { name: "Bcc", value: "bcc@example.com" },
              ],
              mimeType: "text/plain",
              body: { data: Buffer.from("body").toString("base64url") },
            },
          },
        });
      },
    ),
    "from@example.com",
  );
  const g = await gmail.nativeDraft("d1");
  assert.deepEqual(g.content.bcc, ["bcc@example.com"]);
  version = "message2";
  await assert.rejects(
    gmail.updateNativeDraft("d1", g.version, g.content, []),
    /REVISION_CONFLICT/,
  );
  await gmail.updateNativeDraft("d1", version, g.content, []);
  assert.equal(calls.at(-1).method, "PUT");
  assert.match(
    Buffer.from(
      JSON.parse(calls.at(-1).body).message.raw,
      "base64url",
    ).toString(),
    /Bcc: bcc@example.com/,
  );
});
