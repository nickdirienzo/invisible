import { GlideClient } from "@valkey/valkey-glide";

let client: GlideClient | null = null;

function parseValkeyUrl(url: string): { host: string; port: number } {
  // valkey://host:port → { host, port }
  const stripped = url.replace(/^valkey:\/\//, "");
  const [host, portStr] = stripped.split(":");
  return { host, port: portStr ? parseInt(portStr, 10) : 6379 };
}

async function getClient(): Promise<GlideClient> {
  if (!client) {
    const url = process.env.VALKEY_URL;
    if (!url) {
      throw new Error(
        "VALKEY_URL not set. DurableMap requires a Valkey connection."
      );
    }
    const { host, port } = parseValkeyUrl(url);
    client = await GlideClient.createClient({
      addresses: [{ host, port }],
    });
  }
  return client;
}

/**
 * A Map-like class backed by Valkey via valkey-glide.
 * Each instance maps to a single Valkey hash identified by `hashKey`.
 * All methods are async — use `await` on every operation.
 *
 * Values are JSON-serialized, so only JSON-safe types are supported.
 */
export class DurableMap<K extends string = string, V = unknown> {
  private readonly hashKey: string;

  constructor(hashKey: string) {
    this.hashKey = hashKey;
  }

  async get(key: K): Promise<V | undefined> {
    const c = await getClient();
    const raw = await c.hget(this.hashKey, key);
    return raw === null ? undefined : (JSON.parse(raw as string) as V);
  }

  async set(key: K, value: V): Promise<this> {
    const c = await getClient();
    await c.hset(this.hashKey, { [key]: JSON.stringify(value) });
    return this;
  }

  async has(key: K): Promise<boolean> {
    const c = await getClient();
    return c.hexists(this.hashKey, key);
  }

  async delete(key: K): Promise<boolean> {
    const c = await getClient();
    const removed = await c.hdel(this.hashKey, [key]);
    return removed > 0;
  }

  async size(): Promise<number> {
    const c = await getClient();
    return c.hlen(this.hashKey);
  }

  async clear(): Promise<void> {
    const c = await getClient();
    await c.del([this.hashKey]);
  }

  async keys(): Promise<K[]> {
    const c = await getClient();
    return (await c.hkeys(this.hashKey)) as K[];
  }

  async values(): Promise<V[]> {
    const c = await getClient();
    const all = await c.hgetall(this.hashKey);
    return all.map((entry) => JSON.parse(entry.value as string) as V);
  }

  async entries(): Promise<[K, V][]> {
    const c = await getClient();
    const all = await c.hgetall(this.hashKey);
    return all.map(
      (entry) =>
        [entry.field as K, JSON.parse(entry.value as string) as V] as [K, V]
    );
  }
}
