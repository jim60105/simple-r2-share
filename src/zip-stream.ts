/**
 * Streaming STORE ZIP of a listed share (spec §7, plan task 9), built on
 * `client-zip`.
 *
 * Why `client-zip` (checked in the published 2.5.1 source):
 * - It only writes STORE entries: the compression method field of every local
 *   and central header is left at 0 and no compressor exists in the package.
 * - It streams: local header, name, the input's chunks as they arrive (CRC-32
 *   computed on the fly), then a data descriptor (flag bit 3); the central
 *   directory is written at the end. Nothing is buffered beyond one chunk.
 * - ZIP64: an entry whose size, or an offset, reaches 0xFFFFFFFF gets 64-bit
 *   data descriptor and central directory fields, and the archive then ends
 *   with the ZIP64 end records. `predictLength` follows the same rules.
 * - Names are written as UTF-8 with the language encoding flag (bit 11) set.
 * - Errors: its output is a `ReadableStream` whose `pull` awaits the input
 *   iterator and each input stream's reader, so a rejection from our
 *   generator or from an R2 body ERRORS the output stream; cancelling the
 *   output calls `throw()` on our generator.
 * - Plain ES module with no Node built-ins (bundles with esbuild
 *   `--platform=neutral`).
 *
 * Objects are fetched lazily, one at a time: the generator below only calls
 * `bucket.get` for the next file once `client-zip` has finished the previous
 * entry and the consumer asks for more bytes. One `get` per file, so the
 * caller must keep `files.length` inside the subrequest budget.
 *
 * Failure handling (spec §7, §8): an object that vanished after listing, an
 * object whose size changed, an R2 read error, or a total byte count that
 * differs from the predicted ZIP length all make the returned stream ERROR,
 * never close cleanly, so the client gets a broken download instead of a
 * truncated archive that looks complete. `onError` is called once with the
 * cause for the server log. An object replaced with different content of the
 * SAME size between listing and download is not detected (no cross-object
 * snapshot is promised; the archive is still internally consistent because
 * CRC-32 and sizes are computed from the bytes actually sent).
 */
import { makeZip, predictLength } from "client-zip";
import type { FileNode } from "./listing";
import { isSafeKey } from "./paths";

/** The listing fields a ZIP entry needs. `path` becomes the entry name. */
export type ZipFile = Pick<FileNode, "path" | "key" | "size" | "uploaded">;

/** The stream could not be completed (see the module comment). */
export class ZipStreamError extends Error {
  override name = "ZipStreamError";
}

/**
 * Throws `TypeError` unless `path` is a safe relative entry name: `/`
 * separated, no leading `/`, no empty, `.` or `..` segment, no backslash, no
 * control characters. `listing` already guarantees this for `FileNode.path`;
 * this is defence in depth so the archive can never contain `../` or absolute
 * entries.
 */
export function assertSafeEntryName(path: string): void {
  if (!isSafeKey(path)) throw new TypeError(`zip-stream: unsafe entry name ${JSON.stringify(path)}`);
}

/** Exact byte length of the archive `createZipStream` produces for `files`. */
export function predictZipLength(files: readonly ZipFile[]): bigint {
  return predictLength(files.map((file) => ({ name: file.path, size: file.size })));
}

export interface ZipStream {
  /** The archive. Errors (never closes) if any entry fails. */
  readonly body: ReadableStream<Uint8Array>;
  /** `predictZipLength(files)`; the body is exactly this long or errors. */
  readonly length: bigint;
}

/**
 * Called once when the stream fails. `entry` is the path of the entry being
 * written (or about to be fetched) at that moment, or `null` before the first.
 * Also called if the consumer goes away mid-download.
 */
export type ZipErrorHandler = (error: unknown, entry: string | null) => void;

/**
 * Streams `files` (in the given order) as a STORE ZIP. Entry names are
 * `file.path`, so the directory structure below the share root is kept and
 * no folder entries are written (unzip tools create the folders from the
 * paths). A file `a` next to a folder `a/` gives the entries `a` and `a/b`:
 * ZIP allows both and we do not silently drop data; some extractors will ask
 * how to resolve the clash.
 *
 * The first `get` starts as soon as this is called; later ones follow the
 * consumer. Do not call it for `HEAD`.
 */
export function createZipStream(bucket: R2Bucket, files: readonly ZipFile[], onError: ZipErrorHandler): ZipStream {
  for (const file of files) assertSafeEntryName(file.path);
  const length = predictZipLength(files);
  const progress: { entry: string | null } = { entry: null };

  const zip = makeZip(entries(bucket, files, progress));
  // The guard passes bytes through unchanged and errors if the total differs
  // from `length`; a failing `zip` aborts it, which errors `guard.readable`.
  const guard = lengthGuard(length);
  zip.pipeTo(guard.writable).catch((error: unknown) => onError(error, progress.entry));
  return { body: guard.readable, length };
}

async function* entries(bucket: R2Bucket, files: readonly ZipFile[], progress: { entry: string | null }) {
  for (const file of files) {
    progress.entry = file.path;
    const object = await bucket.get(file.key);
    if (object === null) {
      throw new ZipStreamError(`${file.key} disappeared after listing`);
    }
    if (object.size !== file.size) {
      await object.body.cancel().catch(() => undefined);
      throw new ZipStreamError(`${file.key} changed size after listing (listed ${file.size}, now ${object.size})`);
    }
    yield { name: file.path, lastModified: file.uploaded, size: file.size, input: object.body };
  }
}

interface ByteTransform {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

/**
 * Workers: the native `FixedLengthStream`, which needs no JavaScript per
 * chunk, makes the runtime send `Content-Length` instead of chunked encoding,
 * and errors if too few or too many bytes pass. Elsewhere (Node tests) a
 * small `TransformStream` with the same contract.
 */
function lengthGuard(length: bigint): ByteTransform {
  const Native = (globalThis as { FixedLengthStream?: typeof FixedLengthStream }).FixedLengthStream;
  if (typeof Native === "function") return new Native(length) as unknown as ByteTransform;
  return countingStream(length);
}

function countingStream(length: bigint): ByteTransform {
  const expected = Number(length);
  let seen = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > expected) throw new ZipStreamError(`ZIP is longer than the predicted ${expected} bytes`);
      controller.enqueue(chunk);
    },
    flush() {
      if (seen !== expected) throw new ZipStreamError(`ZIP is ${seen} bytes, predicted ${expected}`);
    },
  });
}
