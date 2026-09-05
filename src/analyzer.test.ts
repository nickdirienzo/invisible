import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { analyzeSource, serializeFacts } from "./analyzer.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("emits no interleaving fact for a synchronous read-modify-write", () => {
  const facts = analyzeSource(
    path.join(repositoryRoot, "test/fixtures/safe-counter.ts"),
    repositoryRoot,
  );
  assert.deepEqual(facts, []);
  assert.equal(serializeFacts(facts), "");
});

test("emits a Waldo fact for read-modify-write across an external await", () => {
  const facts = analyzeSource(
    path.join(repositoryRoot, "test/fixtures/unsafe-counter.ts"),
    repositoryRoot,
  );

  assert.equal(facts.length, 1);
  assert.deepEqual(facts[0], {
    id: "state-rmw-across-yield:test/fixtures/unsafe-counter.ts:counters",
    kind: "state-rmw-across-yield",
    source: {
      path: "test/fixtures/unsafe-counter.ts",
      line: 7,
      column: 19,
    },
    symbol: "counters",
    attributes: {
      "atomicity.required": true,
      "state.scope": "cell",
      "yield.kind": "external",
    },
  });
  assert.equal(serializeFacts(facts).trim(), JSON.stringify(facts[0]));
});
