import { workerData, parentPort } from "node:worker_threads";
import { TextDecoder } from "node:util";
import yauzl from "yauzl";
const MAX = 100_000,
  bytes = Buffer.from(workerData.content);
async function docx() {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true },
      (error, zip) => {
        if (error) return reject(error);
        let entries = 0,
          expanded = 0,
          document = "";
        zip.on("error", reject);
        zip.on("entry", (entry) => {
          entries++;
          expanded += entry.uncompressedSize;
          if (
            entries > 1000 ||
            expanded > 20 * 1024 * 1024 ||
            entry.generalPurposeBitFlag & 1
          ) {
            zip.close();
            return reject(Error("ZIP_LIMIT"));
          }
          if (entry.fileName !== "word/document.xml") return zip.readEntry();
          if (entry.uncompressedSize > 2 * 1024 * 1024) {
            zip.close();
            return reject(Error("DOCX_TOO_LARGE"));
          }
          zip.openReadStream(entry, (e, stream) => {
            if (e) return reject(e);
            const chunks = [];
            let size = 0;
            stream.on("error", reject);
            stream.on("data", (b) => {
              size += b.length;
              if (size > 2 * 1024 * 1024) {
                stream.destroy(Error("DOCX_TOO_LARGE"));
                zip.close();
              } else chunks.push(b);
            });
            stream.on("end", () => {
              document = Buffer.concat(chunks).toString();
              zip.readEntry();
            });
          });
        });
        zip.on("end", () =>
          resolve(
            document
              .replace(/<\/w:p>/g, "\n")
              .replace(/<[^>]+>/g, "")
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/&quot;/g, '"')
              .replace(/&apos;/g, "'")
              .replace(/&amp;/g, "&"),
          ),
        );
        zip.readEntry();
      },
    );
  });
}
async function run() {
  const type = String(workerData.type).toLowerCase().split(";")[0],
    name = String(workerData.name).toLowerCase();
  let text = "",
    truncated = false;
  if (type === "application/pdf" || name.endsWith(".pdf")) {
    if (bytes.subarray(0, 5).toString() !== "%PDF-")
      throw Error("PDF_SIGNATURE");
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
    });
    const pdf = await task.promise;
    try {
      for (let i = 1; i <= Math.min(pdf.numPages, 50); i++) {
        const page = await pdf.getPage(i),
          data = await page.getTextContent();
        text +=
          data.items.map((x) => ("str" in x ? x.str : "")).join(" ") + "\n";
        if (text.length > MAX) {
          truncated = true;
          break;
        }
      }
      truncated ||= pdf.numPages > 50;
    } finally {
      await task.destroy();
    }
  } else if (
    type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.endsWith(".docx")
  )
    text = await docx();
  else if (
    /^text\//.test(type) ||
    ["application/json", "application/xml"].includes(type)
  )
    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  else return { text: "", truncated: false, supported: false };
  return {
    text: text.slice(0, MAX),
    truncated: truncated || text.length > MAX,
    supported: true,
  };
}
try {
  parentPort.postMessage(await run());
} catch {
  parentPort.postMessage({ error: "EXTRACTION_FAILED" });
}
