// Distributed EventEmitter — replaces node:events EventEmitter with Dapr pub/sub.
// emit() publishes to Dapr, handlers are invoked when Dapr delivers messages
// through the II internal server.

const DAPR_PORT = process.env.DAPR_HTTP_PORT || "3500";
const PUBSUB_NAME = "ii-pubsub";

export class DistributedEventEmitter {
  #namespace;
  #handlers = new Map();

  constructor(namespace) {
    this.#namespace = namespace;
    globalThis.__ii_event_emitters = globalThis.__ii_event_emitters || [];
    globalThis.__ii_event_emitters.push(this);
  }

  on(event, handler) {
    if (!this.#handlers.has(event)) {
      this.#handlers.set(event, new Set());
    }
    this.#handlers.get(event).add(handler);
    return this;
  }

  once(event, handler) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      handler(...args);
    };
    wrapper._original = handler;
    return this.on(event, wrapper);
  }

  off(event, handler) {
    const set = this.#handlers.get(event);
    if (set) {
      set.delete(handler);
      for (const h of set) {
        if (h._original === handler) {
          set.delete(h);
          break;
        }
      }
    }
    return this;
  }

  removeListener(event, handler) {
    return this.off(event, handler);
  }

  async emit(event, ...args) {
    const topic = `${this.#namespace}.${event}`;
    try {
      await fetch(`http://localhost:${DAPR_PORT}/v1.0/publish/${PUBSUB_NAME}/${topic}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args }),
      });
    } catch (err) {
      console.error(`[ii] Failed to publish to ${topic}:`, err.message);
    }
    return true;
  }

  _deliver(event, data) {
    const set = this.#handlers.get(event);
    if (!set) return;
    const args = data?.args ?? [];
    for (const handler of set) {
      try {
        handler(...args);
      } catch (err) {
        console.error(`[ii] Handler error for ${this.#namespace}.${event}:`, err);
      }
    }
  }

  get _namespace() { return this.#namespace; }
}
