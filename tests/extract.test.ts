import test from "node:test";
import assert from "node:assert/strict";
import { extract } from "../src/extract.js";
function zip(files: Record<string, string>) {
  const chunks: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name),
      data = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    chunks.push(local, filename, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(filename.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, filename);
    offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}
test("Office/OpenDocument, HTML and RTF extraction and OCR input bounds", async () => {
  for (const [name, files, expected] of [
    [
      "a.docx",
      {
        "word/document.xml":
          "<w:document><w:p><w:t>合同</w:t></w:p></w:document>",
      },
      "合同",
    ],
    [
      "a.pptx",
      {
        "ppt/slides/slide1.xml":
          "<p:sld><a:p><a:t>演示文本</a:t></a:p></p:sld>",
      },
      "演示文本",
    ],
    [
      "a.xlsx",
      {
        "xl/sharedStrings.xml": "<sst><si><t>发票</t></si></sst>",
        "xl/worksheets/sheet1.xml":
          '<worksheet><row><c t="s"><v>0</v></c><c><v>123</v></c></row></worksheet>',
      },
      "发票123",
    ],
    [
      "a.odt",
      {
        "content.xml":
          "<office:document><text:p>开放文档</text:p></office:document>",
      },
      "开放文档",
    ],
  ] as const)
    assert.match(
      (
        await extract(
          zip(files as Record<string, string>),
          "application/octet-stream",
          name,
        )
      ).text,
      new RegExp(expected),
    );
  const html = await extract(
    Buffer.from("<p>合同金额</p><script>secret()</script>"),
    "text/html",
    "a.html",
  );
  assert.match(html.text, /合同金额/);
  assert.ok(!html.text.includes("secret()"));
  assert.match(
    (
      await extract(
        Buffer.from("{\\rtf1\\ansi Hello \\u20320?\\u22909?}"),
        "application/rtf",
        "a.rtf",
      )
    ).text,
    /Hello 你好/,
  );
  const image = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
  image.writeUInt32BE(100000, 16);
  image.writeUInt32BE(100000, 20);
  await assert.rejects(
    extract(image, "image/png", "large.png", {
      ocr: { binary: "/must-not-execute", languages: "eng" },
    }),
    /EXTRACTION_FAILED/,
  );
});
test("attachment extraction is bounded, explicit and isolated", async (t) => {
  await t.test(
    "valid PDF text extracts without executing active content",
    async () => {
      const stream = "BT /F1 12 Tf 20 180 Td (Hello PDF) Tj ET";
      const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      ];
      let pdf = "%PDF-1.4\n";
      const offsets = [0];
      for (let i = 0; i < objects.length; i++) {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
      }
      const xref = Buffer.byteLength(pdf);
      pdf +=
        `xref\n0 6\n0000000000 65535 f \n` +
        offsets
          .slice(1)
          .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
          .join("") +
        `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      assert.match(
        (await extract(Buffer.from(pdf), "application/pdf", "a.pdf")).text,
        /Hello PDF/,
      );
    },
  );
  await t.test("UTF-8 text extracted", async () => {
    assert.equal(
      (await extract(Buffer.from("你好，发票"), "text/plain", "a.txt")).text,
      "你好，发票",
    );
  });
  await t.test("unsupported binary is explicit", async () => {
    assert.equal(
      (
        await extract(
          Buffer.from([0, 1, 2]),
          "application/octet-stream",
          "a.bin",
        )
      ).supported,
      false,
    );
  });
  await t.test("large text is marked truncated", async () => {
    const r = await extract(Buffer.alloc(150_000, 65), "text/plain", "a.txt");
    assert.equal(r.text.length, 100_000);
    assert.equal(r.truncated, true);
  });
  await t.test("invalid PDF and ZIP safely fail", async () => {
    await assert.rejects(
      extract(Buffer.from("not-pdf"), "application/pdf", "a.pdf"),
      /EXTRACTION_FAILED/,
    );
    await assert.rejects(
      extract(
        Buffer.from("not-zip"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "a.docx",
      ),
      /EXTRACTION_FAILED/,
    );
  });
  await t.test("oversize rejected before worker creation", async () => {
    await assert.rejects(
      extract(Buffer.alloc(9 * 1024 * 1024), "text/plain", "a.txt"),
      /TOO_LARGE/,
    );
  });
});
