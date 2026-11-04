import { XMLParser, XMLValidator } from "fast-xml-parser";
import { MailError } from "../domain.js";
export const xml = (v: unknown) =>
  String(v ?? "").replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
export const array = <T>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];
export const value = (v: any): string =>
  typeof v === "object" ? String(v?.["#text"] ?? "") : String(v ?? "");
export function parseXml(raw: string, maxBytes = 2 * 1024 * 1024) {
  if (Buffer.byteLength(raw) > maxBytes || /<!\s*(?:DOCTYPE|ENTITY)/i.test(raw))
    throw new MailError("INVALID_XML", 502);
  let depth = 0,
    count = 0;
  for (const m of raw.matchAll(/<\/?[A-Za-z_][^>]*>/g)) {
    if (++count > 20_000) throw new MailError("XML_LIMIT", 502);
    if (m[0].startsWith("</")) depth--;
    else if (!m[0].endsWith("/>")) depth++;
    if (depth > 64 || depth < 0) throw new MailError("XML_LIMIT", 502);
  }
  if (XMLValidator.validate(raw) !== true)
    throw new MailError("INVALID_XML", 502);
  return new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: true,
  }).parse(raw);
}
