import { createReadStream } from "node:fs";

export type ByteRange = { start: number; end: number };

export function parseByteRange(header: string | null, size: number): ByteRange | null | "invalid" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return "invalid";

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "invalid";
  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
    const length = Math.min(suffixLength, size);
    return { start: size - length, end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return "invalid";
  return { start, end };
}

// `Readable.toWeb(createReadStream(...))` can surface an uncaught
// ERR_INVALID_STATE in Next when a browser cancels a video range request.
// This bridge destroys the Node stream on cancellation before the response
// controller closes, so a discarded metadata request stays request-local.
export function fileReadStream(filePath: string, range?: ByteRange): ReadableStream<Uint8Array> {
  const stream = createReadStream(filePath, range);
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on("data", (chunk: string | Buffer) => {
        if (closed) return;
        controller.enqueue(new Uint8Array(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
        if ((controller.desiredSize ?? 1) <= 0) stream.pause();
      });
      stream.once("end", () => {
        if (closed) return;
        closed = true;
        controller.close();
      });
      stream.once("error", (error) => {
        if (closed) return;
        closed = true;
        controller.error(error);
      });
    },
    pull() {
      stream.resume();
    },
    cancel() {
      closed = true;
      stream.destroy();
    },
  });
}
