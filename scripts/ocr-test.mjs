import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extract } from "../dist/src/extract.js";
const bytes = await readFile(
  new URL("../tests/fixtures/ocr-invoice.png", import.meta.url),
);
const result = await extract(bytes, "image/png", "invoice.png", {
  ocr: {
    binary: process.env.OCR_TEST_BINARY || "/usr/bin/tesseract",
    languages: "eng",
  },
});
assert.equal(result.supported, true);
assert.match(result.text, /Invoice\s+12345/i);
console.info(
  "PASS: actual Tesseract PNG OCR, synthetic Invoice12345, bounded extraction worker",
);
