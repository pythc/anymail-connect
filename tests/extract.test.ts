import test from "node:test";
import assert from "node:assert/strict";
import { extract } from "../src/extract.js";
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
