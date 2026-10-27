/**
 * In-memory stand-in for the parts of `R2Bucket` this project uses (`get` and
 * `list`). Keys are listed in UTF-8 byte order like R2. Failures can be
 * injected per call; extend this class rather than writing another fake.
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

export class FakeBucket {
  readonly objects = new Map<string, Uint8Array>();
  pageSize: number;
  /** Makes `get(key)` reject. */
  failGet: FailureHook<string> | null = null;
  /** Makes reading the body of `get(key)` reject. */
  failBody: FailureHook<string> | null = null;
  /** Makes `list(options)` reject. */
  failList: FailureHook<R2ListOptions> | null = null;
  readonly getCalls: string[] = [];
  readonly listCalls: R2ListOptions[] = [];

  constructor(options: FakeBucketOptions = {}) {
    this.pageSize = options.pageSize ?? 1000;
  }

  put(key: string, body: string | Uint8Array = ""): this {
    this.objects.set(key, typeof body === "string" ? encoder.encode(body) : body);
    return this;
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
      ...this.#metadata(key, bytes),
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

  async list(options: R2ListOptions = {}): Promise<R2Objects> {
    this.listCalls.push({ ...options });
    const error = this.failList?.(options);
    if (error !== undefined) throw error;
    if (options.delimiter !== undefined) throw new Error("FakeBucket: delimiter is not supported");

    const prefix = options.prefix ?? "";
    const after = options.cursor ?? options.startAfter;
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix) && (after === undefined || compareKeys(key, after) > 0))
      .sort(compareKeys);
    const limit = Math.min(options.limit ?? 1000, this.pageSize);
    const page = keys.slice(0, limit);
    const objects = page.map((key) => this.#metadata(key, this.objects.get(key) as Uint8Array) as unknown as R2Object);
    const last = page[page.length - 1];
    if (keys.length > page.length && last !== undefined) {
      return { objects, delimitedPrefixes: [], truncated: true, cursor: last };
    }
    return { objects, delimitedPrefixes: [], truncated: false };
  }

  #metadata(key: string, bytes: Uint8Array) {
    return {
      key,
      version: "fake",
      size: bytes.byteLength,
      etag: "fake",
      httpEtag: '"fake"',
      uploaded: new Date(0),
      storageClass: "Standard",
      checksums: {},
      httpMetadata: {},
      customMetadata: {},
      writeHttpMetadata: () => undefined,
    };
  }
}
