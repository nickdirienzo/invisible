export function renderRuntimePrefix(): string {
  return String.raw`
let __iiSql;
let __iiRequestHandler;

function __iiBindStorage(sql) {
  __iiSql = sql;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS __invisible_map_entries (" +
      "map_id TEXT NOT NULL," +
      "key TEXT NOT NULL," +
      "value TEXT NOT NULL," +
      "ordinal INTEGER NOT NULL," +
      "PRIMARY KEY (map_id, key)" +
    ")"
  );
}

function __iiStorage() {
  if (!__iiSql) {
    throw new Error("Invisible durable state used outside AppCell");
  }
  return __iiSql;
}

function __iiEncodeValue(value) {
  const type = typeof value;
  if (!["string", "number", "boolean"].includes(type)) {
    throw new TypeError("Invisible v2 Map values must be primitive");
  }
  if (type === "number" && !Number.isFinite(value)) {
    throw new TypeError("Invisible v2 Map numbers must be finite");
  }
  return JSON.stringify(value);
}

class __InvisibleDurableMap extends Map {
  constructor(id) {
    super();
    this.id = id;
  }

  get(key) {
    if (typeof key !== "string") {
      throw new TypeError("Invisible v2 Map keys must be strings");
    }
    const row = __iiStorage()
      .exec(
        "SELECT value FROM __invisible_map_entries WHERE map_id = ? AND key = ?",
        this.id,
        key
      )
      .toArray()[0];
    return row ? JSON.parse(row.value) : undefined;
  }

  set(key, value) {
    if (typeof key !== "string") {
      throw new TypeError("Invisible v2 Map keys must be strings");
    }
    __iiStorage().exec(
      "INSERT INTO __invisible_map_entries (map_id, key, value, ordinal) " +
        "SELECT ?, ?, ?, COALESCE(MAX(ordinal) + 1, 0) " +
        "FROM __invisible_map_entries WHERE map_id = ? " +
        "ON CONFLICT(map_id, key) DO UPDATE SET value = excluded.value",
      this.id,
      key,
      __iiEncodeValue(value),
      this.id
    );
    return this;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    const existed = this.has(key);
    if (existed) {
      __iiStorage().exec(
        "DELETE FROM __invisible_map_entries WHERE map_id = ? AND key = ?",
        this.id,
        key
      );
    }
    return existed;
  }

  clear() {
    __iiStorage().exec(
      "DELETE FROM __invisible_map_entries WHERE map_id = ?",
      this.id
    );
  }

  get size() {
    return __iiStorage()
      .exec(
        "SELECT COUNT(*) AS count FROM __invisible_map_entries WHERE map_id = ?",
        this.id
      )
      .toArray()[0].count;
  }

  entries() {
    return __iiStorage()
      .exec(
        "SELECT key, value FROM __invisible_map_entries " +
          "WHERE map_id = ? ORDER BY ordinal",
        this.id
      )
      .toArray()
      .map((row) => [row.key, JSON.parse(row.value)])[Symbol.iterator]();
  }

  keys() {
    return Array.from(this.entries(), ([key]) => key)[Symbol.iterator]();
  }

  values() {
    return Array.from(this.entries(), ([, value]) => value)[Symbol.iterator]();
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  forEach(callback, thisArg) {
    for (const [key, value] of this.entries()) {
      callback.call(thisArg, value, key, this);
    }
  }
}

function createServer(handler) {
  if (__iiRequestHandler) {
    throw new Error("Invisible v2 supports exactly one HTTP server");
  }
  __iiRequestHandler = handler;
  return {
    listen() {
      return this;
    }
  };
}

class __InvisibleServerResponse {
  constructor(resolve) {
    this.resolve = resolve;
    this.statusCode = 200;
    this.headers = new Headers();
    this.chunks = [];
    this.ended = false;
  }

  setHeader(name, value) {
    this.headers.set(name, String(value));
    return this;
  }

  getHeader(name) {
    return this.headers.get(name) ?? undefined;
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    if (headers) {
      for (const [name, value] of Object.entries(headers)) {
        this.setHeader(name, value);
      }
    }
    return this;
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  end(chunk) {
    if (this.ended) return this;
    if (chunk !== undefined) this.write(chunk);
    this.ended = true;
    this.resolve(
      new Response(this.chunks.join(""), {
        status: this.statusCode,
        headers: this.headers
      })
    );
    return this;
  }
}

async function __iiDispatch(request) {
  if (!__iiRequestHandler) {
    throw new Error("Node HTTP server was not registered");
  }
  const url = new URL(request.url);
  const incoming = {
    method: request.method,
    url: url.pathname + url.search,
    headers: Object.fromEntries(request.headers)
  };
  return new Promise((resolve, reject) => {
    const response = new __InvisibleServerResponse(resolve);
    try {
      Promise.resolve(__iiRequestHandler(incoming, response)).catch(reject);
    } catch (error) {
      reject(error);
    }
  });
}
`.trimStart();
}

export function renderRuntimeSuffix(): string {
  return String.raw`
export class AppCell {
  constructor(state) {
    __iiBindStorage(state.storage.sql);
  }

  fetch(request) {
    return __iiDispatch(request);
  }
}

export default {
  fetch(request, env) {
    return env.APP.getByName("global").fetch(request);
  }
};
`.trimStart();
}

export function renderWranglerConfig(name: string): string {
  return `${JSON.stringify(
    {
      name,
      main: "index.js",
      compatibility_date: "2026-09-01",
      durable_objects: {
        bindings: [{ name: "APP", class_name: "AppCell" }],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["AppCell"] }],
    },
    null,
    2,
  )}\n`;
}
