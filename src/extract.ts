import { Worker } from "node:worker_threads";
import { MailError } from "./domain.js";
let active = 0;
let activeOcr = 0;
export async function extract(
  content: Buffer,
  type: string,
  name: string,
  options: { ocr?: { binary: string; languages: string } } = {},
): Promise<{ text: string; truncated: boolean; supported: boolean }> {
  if (content.length > 8 * 1024 * 1024)
    throw new MailError("ATTACHMENT_TOO_LARGE", 413);
  if (active >= 4) throw new MailError("EXTRACTION_BUSY", 429);
  if (options.ocr && activeOcr >= 1) throw new MailError("OCR_BUSY", 429);
  active++;
  if (options.ocr) activeOcr++;
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./extract-worker.mjs", import.meta.url),
      {
        workerData: { content, type, name, ocr: options.ocr },
        env: {},
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: 96,
          maxYoungGenerationSizeMb: 16,
        },
      },
    );
    let settled = false;
    const finish = (
      error?: Error,
      result?: { text: string; truncated: boolean; supported: boolean },
    ) => {
      if (settled) return;
      settled = true;
      active--;
      if (options.ocr) activeOcr--;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(
      () => finish(new MailError("EXTRACTION_TIMEOUT", 422)),
      8000,
    );
    worker.once("message", (result) =>
      result.error
        ? finish(new MailError("EXTRACTION_FAILED", 422))
        : finish(undefined, result),
    );
    worker.once("error", () => finish(new MailError("EXTRACTION_FAILED", 422)));
    worker.once("exit", () => {
      if (!settled) finish(new MailError("EXTRACTION_FAILED", 422));
    });
  });
}
