import { MailError } from "../domain.js";
import { type HttpRequest, providerError } from "../network.js";
import { Rest, enc } from "./rest.js";
import { array, parseXml, value, xml } from "./xml.js";
const fields = "names,emailAddresses,phoneNumbers,metadata";
const person = (p: any) => ({
  id: p.resourceName,
  etag: p.etag,
  displayName: p.names?.[0]?.displayName,
  givenName: p.names?.[0]?.givenName,
  surname: p.names?.[0]?.familyName,
  emailAddresses: array<any>(p.emailAddresses).map((e) => ({
    address: e.value,
  })),
  businessPhones: array<any>(p.phoneNumbers).map((e) => e.value),
});
export async function people(api: Rest, op: string, i: any) {
  const id = String(i.id ?? "");
  if (
    op !== "contacts.list" &&
    op !== "contacts.create" &&
    !/^people\/[a-zA-Z0-9_-]+$/.test(id)
  )
    throw new MailError("INVALID_CONTACT_ID");
  if (op === "contacts.list") {
    const r = await api.call(
      "/people/me/connections?" +
        new URLSearchParams({
          personFields: fields,
          pageSize: "50",
          ...(i.cursor ? { pageToken: i.cursor } : {}),
        }),
    );
    return {
      items: array<any>(r.connections).map(person),
      cursor: r.nextPageToken,
      coverage: "native-contacts",
    };
  }
  const path = "/" + id;
  if (op === "contacts.get")
    return person(await api.call(path + "?personFields=" + fields));
  if (op === "contacts.delete")
    return api.call(path + ":deleteContact", "DELETE");
  const c = i.contact ?? {},
    body: any = {
      names: [
        {
          givenName: c.givenName ?? c.displayName ?? "",
          familyName: c.surname ?? "",
        },
      ],
      emailAddresses: (c.emailAddresses ?? []).map((e: any) => ({
        value: e.address,
      })),
      phoneNumbers: (c.businessPhones ?? []).map((value: string) => ({
        value,
      })),
    };
  if (op === "contacts.create")
    return person(
      await api.call(
        "/people:createContact?personFields=" + fields,
        "POST",
        body,
      ),
    );
  if (op === "contacts.update") {
    if (!i.etag) throw new MailError("ETAG_REQUIRED");
    const previous = await api.call(path + "?personFields=" + fields);
    if (previous.etag !== i.etag) throw new MailError("REVISION_CONFLICT", 409);
    if (
      c.givenName === undefined &&
      c.surname === undefined &&
      c.displayName === undefined
    )
      delete body.names;
    else
      body.names = [
        {
          givenName:
            c.givenName ??
            c.displayName ??
            previous.names?.[0]?.givenName ??
            "",
          familyName: c.surname ?? previous.names?.[0]?.familyName ?? "",
        },
      ];
    if (c.emailAddresses === undefined) delete body.emailAddresses;
    if (c.businessPhones === undefined) delete body.phoneNumbers;
    const mask = Object.keys(body).join(",");
    if (!mask) throw new MailError("EMPTY_CONTACT_UPDATE");
    body.etag = previous.etag;
    body.metadata = previous.metadata;
    return person(
      await api.call(
        path +
          ":updateContact?updatePersonFields=" +
          mask +
          "&personFields=" +
          fields,
        "PATCH",
        body,
      ),
    );
  }
  throw new MailError("UNSUPPORTED_CAPABILITY", 422);
}
export type CardDavConfig = { url: string; username: string; password: string };
export class CardDav {
  private base: URL;
  constructor(
    private c: CardDavConfig,
    private http: HttpRequest,
  ) {
    this.base = new URL(c.url);
    if (
      this.base.protocol !== "https:" ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      !this.base.pathname.endsWith("/")
    )
      throw new MailError("INVALID_CARDDAV_URL");
  }
  private target(id: string) {
    if (
      !id ||
      id.length > 500 ||
      /[\/\\\x00-\x1f]/.test(id) ||
      id === "." ||
      id === ".."
    )
      throw new MailError("INVALID_CONTACT_ID");
    return this.base.href + enc(id);
  }
  private async call(
    url: string,
    method: string,
    body?: string,
    headers: Record<string, string> = {},
  ) {
    const r = await this.http(url, {
      method,
      body,
      maxBytes: 2 * 1024 * 1024,
      headers: {
        authorization:
          "Basic " +
          Buffer.from(this.c.username + ":" + this.c.password).toString(
            "base64",
          ),
        "content-type": "application/xml; charset=utf-8",
        ...headers,
      },
    });
    if (r.status === 412) throw new MailError("REVISION_CONFLICT", 409);
    if (r.status < 200 || r.status >= 300) providerError(r.status, r.headers);
    return r;
  }
  private contact(raw: string, id: string, etag: string) {
    if (raw.length > 100_000 || !raw.includes("BEGIN:VCARD"))
      throw new MailError("INVALID_VCARD", 502);
    const lines = raw.replace(/\r?\n[ \t]/g, "").split(/\r?\n/),
      props = (name: string) =>
        lines
          .filter(
            (l) =>
              l.split(/[;:]/)[0]?.split(".").at(-1)?.toUpperCase() === name,
          )
          .map((l) =>
            l
              .slice(l.indexOf(":") + 1)
              .replace(/\\n/gi, "\n")
              .replace(/\\([,;\\])/g, "$1"),
          );
    return {
      id,
      etag,
      displayName: props("FN")[0] ?? "",
      emailAddresses: props("EMAIL").map((address) => ({ address })),
      businessPhones: props("TEL"),
    };
  }
  async run(op: string, i: any) {
    if (op === "contacts.list") {
      const offset = Number(i.cursor ?? 0);
      if (!Number.isInteger(offset) || offset < 0 || offset > 500)
        throw new MailError("INVALID_CURSOR");
      const r = await this.call(
        this.base.href,
        "REPORT",
        '<c:addressbook-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><c:address-data/></d:prop><c:filter/><c:limit><c:nresults>500</c:nresults></c:limit></c:addressbook-query>',
        { depth: "1" },
      );
      const responses = array<any>(
          parseXml(r.body.toString()).multistatus?.response,
        ),
        items = [];
      for (const row of responses.slice(0, 500)) {
        const u = new URL(value(row.href), this.base),
          relative = u.pathname.slice(this.base.pathname.length);
        if (
          u.origin !== this.base.origin ||
          !u.pathname.startsWith(this.base.pathname) ||
          relative.includes("/") ||
          u.search ||
          u.hash
        )
          throw new MailError("CARDDAV_ORIGIN_DENIED", 502);
        const id = decodeURIComponent(relative);
        this.target(id);
        const prop = array<any>(row.propstat).find((p) =>
          / 200 /.test(value(p.status)),
        )?.prop;
        if (prop?.["address-data"])
          items.push(
            this.contact(value(prop["address-data"]), id, value(prop.getetag)),
          );
      }
      return {
        items: items.slice(offset, offset + 50),
        cursor: offset + 50 < items.length ? String(offset + 50) : undefined,
        coverage: "bounded-500-carddav-snapshot",
        truncated: responses.length >= 500,
      };
    }
    const id =
        op === "contacts.create"
          ? crypto.randomUUID() + ".vcf"
          : String(i.id ?? ""),
      url = this.target(id);
    if (op === "contacts.get") {
      const r = await this.call(url, "GET");
      return this.contact(r.body.toString(), id, r.headers.etag ?? "");
    }
    if (!["contacts.create", "contacts.update", "contacts.delete"].includes(op))
      throw new MailError("UNSUPPORTED_CAPABILITY", 422);
    if (op !== "contacts.create" && !i.etag)
      throw new MailError("ETAG_REQUIRED");
    if (op === "contacts.delete") {
      await this.call(url, "DELETE", undefined, { "if-match": i.etag });
      return { deleted: true };
    }
    const c = i.contact ?? {},
      escape = (s: string) =>
        String(s)
          .replace(/\\/g, "\\\\")
          .replace(/\r\n|\r|\n/g, "\\n")
          .replace(/[,;]/g, "\\$&");
    let preserved: string[] = [],
      oldNames: string[] = [];
    const names = c.givenName !== undefined || c.surname !== undefined,
      replaceFn = names || c.displayName !== undefined;
    if (op === "contacts.update") {
      const r = await this.call(url, "GET");
      if (r.headers.etag !== i.etag)
        throw new MailError("REVISION_CONFLICT", 409);
      const lines = r.body
        .toString()
        .replace(/\r?\n[ \t]/g, "")
        .split(/\r?\n/);
      oldNames = (
        lines.find((l) => /^(?:[a-z0-9_-]+\.)?N[:;]/i.test(l)) ?? "N:"
      )
        .split(":")
        .slice(1)
        .join(":")
        .split(/(?<!\\);/)
        .map((s) => s.replace(/\\([,;\\])/g, "$1"));
      preserved = lines.filter(
        (l) =>
          l &&
          !/^(BEGIN|END|VERSION)(?:[:;])/i.test(l) &&
          !(replaceFn && /^(?:[a-z0-9_-]+\.)?FN[:;]/i.test(l)) &&
          !(names && /^(?:[a-z0-9_-]+\.)?N[:;]/i.test(l)) &&
          !(
            c.emailAddresses !== undefined &&
            /^(?:[a-z0-9_-]+\.)?EMAIL[:;]/i.test(l)
          ) &&
          !(
            c.businessPhones !== undefined &&
            /^(?:[a-z0-9_-]+\.)?TEL[:;]/i.test(l)
          ),
      );
    }
    const raw = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      ...preserved,
      ...(op === "contacts.create" ? ["UID:" + crypto.randomUUID()] : []),
      ...(replaceFn || op === "contacts.create"
        ? [
            "FN:" +
              escape(
                c.displayName ??
                  [c.givenName ?? oldNames[1], c.surname ?? oldNames[0]]
                    .filter(Boolean)
                    .join(" "),
              ),
          ]
        : []),
      ...(names || op === "contacts.create"
        ? [
            "N:" +
              escape(c.surname ?? oldNames[0] ?? "") +
              ";" +
              escape(c.givenName ?? oldNames[1] ?? "") +
              ";;;",
          ]
        : []),
      ...(c.emailAddresses ?? []).map((e: any) => "EMAIL:" + escape(e.address)),
      ...(c.businessPhones ?? []).map((p: string) => "TEL:" + escape(p)),
      "END:VCARD",
      "",
    ].join("\r\n");
    const r = await this.call(url, "PUT", raw, {
      "content-type": "text/vcard; charset=utf-8",
      ...(op === "contacts.create"
        ? { "if-none-match": "*" }
        : { "if-match": i.etag }),
    });
    return this.contact(raw, id, r.headers.etag ?? "");
  }
}
