/**
 * In-memory stand-in for the parts of `R2Bucket` this project uses (`get`,
 * `head`, `put` and `list`). Keys are listed in UTF-8 byte order like R2.
 * Failures can be injected per call; extend this class rather than writing
 * another fake.
 *
 * `add()` seeds objects for a test; `put()` is the R2 API, including
 * conditional writes (`onlyIf`). Each write gets a new etag.
 */
export interface FakeBucketOptions {
  /** Maximum objects per `list()` page; the smaller of this and `limit` wins. Default 1000. */
  pageSize?: number;
}

/** Returns an error to throw for this call, or `undefined` to proceed. */
export type FailureHook<T> = (arg: T) => unknown;

const encoder = new TextEncoder();

function compareKeys(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const length = Math.min(x.length, y.length);
  for (let i = 0; i < length; i++) {
    const diff = (x[i] as number) - (y[i] as number);
    if (diff !== 0) return diff;
  }
  return x.length - y.length;
}

interface Metadata {
  readonly etag: string;
  /** `null` reports `new Date(0)`. */
  readonly uploaded: Date | null;
  readonly httpMetadata: R2HTTPMetadata;
}

/** The `onlyIf` conditions `put()` understands, from either form R2 accepts. */
function conditions(onlyIf: R2Conditional | Headers | undefined): { matches?: string; doesNotMatch?: string } {
  if (onlyIf === undefined) return {};
  if (onlyIf instanceof Headers) {
    const unquote = (value: string | null) => (value === null ? undefined : value.replace(/^"(.*)"$/, "$1"));
    return { matches: unquote(onlyIf.get("If-Match")), doesNotMatch: unquote(onlyIf.get("If-None-Match")) };
  }
  if (onlyIf.uploadedBefore !== undefined || onlyIf.uploadedAfter !== undefined) {
    throw new Error("FakeBucket: uploadedBefore / uploadedAfter are not supported");
  }
  return { matches: onlyIf.etagMatches, doesNotMatch: onlyIf.etagDoesNotMatch };
}

export class FakeBucket {
  readonly objects = new Map<string, Uint8Array>();
  readonly #metadata = new Map<string, Metadata>();
  #writes = 0;
  pageSize: number;
  /** Time stamp for `put()`; tests may replace it. */
  now: () => Date = () => new Date();
  /** Makes `get(key)` reject. */
  failGet: FailureHook<string> | null = null;
  /** Makes reading the body of `get(key)` reject. */
  failBody: FailureHook<string> | null = null;
  /** Makes `list(options)` reject. */
  failList: FailureHook<R2ListOptions> | null = null;
  /** Makes `put(key)` reject before anything is written. */
  failPut: FailureHook<string> | null = null;
  /** Rewrites each `list()` page before it is returned, e.g. to fake a cursor that never advances. */
  mapList: ((page: R2Objects, options: R2ListOptions) => R2Objects) | null = null;
  readonly getCalls: string[] = [];
  readonly listCalls: R2ListOptions[] = [];
  readonly putCalls: { key: string; options: R2PutOptions | undefined }[] = [];

  constructor(options: FakeBucketOptions = {}) {
    this.pageSize = options.pageSize ?? 1000;
  }

  /** Seeds an object (not recorded as a call); `uploaded` defaults to `new Date(0)`. */
  add(key: string, body: string | Uint8Array = "", uploaded?: Date): this {
    this.#write(key, typeof body === "string" ? encoder.encode(body) : body, uploaded ?? null, {});
    return this;
  }

  #write(key: string, bytes: Uint8Array, uploaded: Date | null, httpMetadata: R2HTTPMetadata): void {
    this.objects.set(key, bytes);
    this.#metadata.set(key, { etag: `etag-${++this.#writes}`, uploaded, httpMetadata });
  }

  /** The fake typed as the Workers binding. */
  asR2Bucket(): R2Bucket {
    return this as unknown as R2Bucket;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    this.getCalls.push(key);
    const error = this.failGet?.(key);
    if (error !== undefined) throw error;
    const bytes = this.objects.get(key);
    if (bytes === undefined) return null;

    const readBody = async (): Promise<Uint8Array> => {
      const bodyError = this.failBody?.(key);
      if (bodyError !== undefined) throw bodyError;
      return bytes.slice();
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(await readBody());
        controller.close();
      },
    });
    const object = {
      ...this.#describe(key, bytes),
      body,
      bodyUsed: false,
      arrayBuffer: async () => (await readBody()).buffer,
      bytes: readBody,
      text: async () => new TextDecoder().decode(await readBody()),
      json: async () => JSON.parse(new TextDecoder().decode(await readBody())) as unknown,
      blob: async () => new Blob([await readBody()]),
    };
    return object as unknown as R2ObjectBody;
  }

  async head(key: string): Promise<R2Object | null> {
    const bytes = this.objects.get(key);
    return bytes === undefined ? null : (this.#describe(key, bytes) as unknown as R2Object);
  }

  /**
   * Writes `value` unless an `onlyIf` condition fails, in which case nothing
   * changes and the result is `null`, like R2. `etagMatches` / `If-Match`
   * needs the object to exist with that etag (`*`: any); `etagDoesNotMatch` /
   * `If-None-Match` fails when the object exists with that etag (`*`: at all).
   */
  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | null,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    this.putCalls.push({ key, options });
    const error = this.failPut?.(key);
    if (error !== undefined) throw error;

    const current = this.objects.has(key) ? this.#metadata.get(key) : undefined;
    const { matches, doesNotMatch } = conditions(options?.onlyIf);
    if (matches !== undefined && (current === undefined || (matches !== "*" && matches !== current.etag))) return null;
    if (doesNotMatch !== undefined && current !== undefined && (doesNotMatch === "*" || doesNotMatch === current.etag)) {
      return null;
    }

    let bytes: Uint8Array;
    if (value === null) bytes = new Uint8Array();
    else if (typeof value === "string") bytes = encoder.encode(value);
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value.slice(0));
    else bytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    const httpMetadata = options?.httpMetadata instanceof Headers ? {} : (options?.httpMetadata ?? {});
    this.#write(key, bytes, this.now(), httpMetadata);
    return this.#describe(key, bytes) as unknown as R2Object;
  }

  /**
   * Lists keys under `prefix`. With `delimiter`, keys that contain it after
   * the prefix are rolled up into `delimitedPrefixes` (each ending with the
   * delimiter); objects and prefixes both count towards `limit`, and the
   * cursor is the last entry returned.
   */
  async list(options: R2ListOptions = {}): Promise<R2Objects> {
    this.listCalls.push({ ...options });
    const error = this.failList?.(options);
    if (error !== undefined) throw error;

    const prefix = options.prefix ?? "";
    const { delimiter } = options;
    const after = options.cursor ?? options.startAfter;
    const entries: { name: string; isPrefix: boolean }[] = [];
    for (const key of [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort(compareKeys)) {
      const cut = delimiter === undefined ? -1 : key.indexOf(delimiter, prefix.length);
      const entry = cut === -1 ? { name: key, isPrefix: false } : { name: key.slice(0, cut + 1), isPrefix: true };
      // Keys sharing a rolled-up prefix are adjacent in byte order.
      if (entry.isPrefix && entries[entries.length - 1]?.name === entry.name) continue;
      if (after === undefined || compareKeys(entry.name, after) > 0) entries.push(entry);
    }
    const limit = Math.min(options.limit ?? 1000, this.pageSize);
    const page = entries.slice(0, limit);
    const objects = page
      .filter((entry) => !entry.isPrefix)
      .map(({ name }) => this.#describe(name, this.objects.get(name) as Uint8Array) as unknown as R2Object);
    const delimitedPrefixes = page.filter((entry) => entry.isPrefix).map(({ name }) => name);
    const last = page[page.length - 1];
    const result: R2Objects =
      entries.length > page.length && last !== undefined
        ? { objects, delimitedPrefixes, truncated: true, cursor: last.name }
        : { objects, delimitedPrefixes, truncated: false };
    return this.mapList ? this.mapList(result, options) : result;
  }

  /** Content type last written by `put()`, for assertions. */
  contentTypeOf(key: string): string | undefined {
    return this.#metadata.get(key)?.httpMetadata.contentType;
  }

  #describe(key: string, bytes: Uint8Array) {
    const metadata = this.#metadata.get(key);
    const etag = metadata?.etag ?? "fake";
    return {
      key,
      version: etag,
      size: bytes.byteLength,
      etag,
      httpEtag: `"${etag}"`,
      uploaded: metadata?.uploaded ?? new Date(0),
      storageClass: "Standard",
      checksums: {},
      httpMetadata: metadata?.httpMetadata ?? {},
      customMetadata: {},
      writeHttpMetadata: () => undefined,
    };
  }
}
