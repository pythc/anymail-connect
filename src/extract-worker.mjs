import { workerData, parentPort } from "node:worker_threads";
import { TextDecoder } from "node:util";
import yauzl from "yauzl";
import { execFile } from "node:child_process";
import { convert } from "html-to-text";
const MAX = 100_000,
  bytes = Buffer.from(workerData.content);
const xmlText = (s) =>
  s
    .replace(/<\/(?:[a-z]+:)?(?:p|row|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_m, n) => {
      const cp =
        n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : "�";
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
async function office() {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true },
      (error, zip) => {
        if (error) return reject(error);
        let entries = 0,
          expanded = 0,
          documents = new Map();
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
          if (
            !/^(word\/document\.xml|ppt\/slides\/slide\d+\.xml|xl\/sharedStrings\.xml|xl\/worksheets\/sheet\d+\.xml|content\.xml)$/.test(
              entry.fileName,
            )
          )
            return zip.readEntry();
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
              documents.set(entry.fileName, Buffer.concat(chunks).toString());
              zip.readEntry();
            });
          });
        });
        zip.on("end", () =>
          resolve(
            (() => {
              const shared = [
                ...(documents.get("xl/sharedStrings.xml") ?? "").matchAll(
                  /<si\b[^>]*>([\s\S]*?)<\/si>/g,
                ),
              ].map((m) => xmlText(m[1]));
              return [...documents.entries()]
                .sort(([a], [b]) =>
                  a.localeCompare(b, undefined, { numeric: true }),
                )
                .filter(([path]) => path !== "xl/sharedStrings.xml")
                .map(([path, raw]) =>
                  xmlText(
                    path.startsWith("xl/")
                      ? raw.replace(
                          /<c\b([^>]*)>([\s\S]*?)<\/c>/g,
                          (_m, attrs, body) =>
                            /\bt="s"/.test(attrs)
                              ? (shared[
                                  Number(/<v>(\d+)<\/v>/.exec(body)?.[1])
                                ] ?? "")
                              : body,
                        )
                      : raw,
                  ),
                )
                .join("\n");
            })(),
          ),
        );
        zip.readEntry();
      },
    );
  });
}
function pixels() {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    if (bytes.includes(Buffer.from("acTL")))
      throw Error("ANIMATED_IMAGE_UNSUPPORTED");
    return bytes.readUInt32BE(16) * bytes.readUInt32BE(20);
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let pos = 2;
    while (pos + 9 < bytes.length) {
      if (bytes[pos] !== 255) throw Error("JPEG_HEADER");
      const marker = bytes[pos + 1],
        length = bytes.readUInt16BE(pos + 2);
      if ([192, 193, 194].includes(marker))
        return bytes.readUInt16BE(pos + 5) * bytes.readUInt16BE(pos + 7);
      if (length < 2) break;
      pos += 2 + length;
    }
  }
  throw Error("OCR_IMAGE_FORMAT");
}
async function ocr() {
  const size = pixels();
  if (!size || size > 16_000_000) throw Error("OCR_IMAGE_LIMIT");
  return new Promise((resolve, reject) => {
    const args = [
      workerData.ocr.binary,
      "stdin",
      "stdout",
      "-l",
      workerData.ocr.languages,
    ];
    const child = execFile(
      process.platform === "linux" ? "/bin/sh" : args[0],
      process.platform === "linux"
        ? ["-c", 'ulimit -v 524288 && ulimit -t 6 && exec "$@"', "ocr", ...args]
        : args.slice(1),
      {
        timeout: 6000,
        killSignal: "SIGKILL",
        maxBuffer: 400_000,
        env: { PATH: "/usr/bin:/bin", OMP_THREAD_LIMIT: "1" },
      },
      (error, out) => (error ? reject(error) : resolve(out)),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(bytes);
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
    /\.(docx|pptx|xlsx|odt|ods|odp)$/.test(name)
  )
    text = await office();
  else if (type === "text/html" || name.endsWith(".html"))
    text = convert(bytes.toString(), { wordwrap: false });
  else if (type === "application/rtf" || name.endsWith(".rtf"))
    text = bytes
      .toString()
      .replace(/\\par\b/g, "\n")
      .replace(/\\u(-?\d+)\??/g, (_m, n) =>
        String.fromCharCode(Number(n) & 65535),
      )
      .replace(/\\'[a-f\d]{2}/gi, (m) =>
        String.fromCharCode(parseInt(m.slice(2), 16)),
      )
      .replace(/\\[a-z]+-?\d* ?|[{}]/gi, "");
  else if (workerData.ocr && ["image/png", "image/jpeg"].includes(type))
    text = await ocr();
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
