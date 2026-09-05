const endpoint = process.argv[2] ?? "http://127.0.0.1:9876/example";
const requests = Number(process.argv[3] ?? 500);
const concurrency = Number(process.argv[4] ?? 32);

let claimed = 0;
const values = [];

async function worker() {
  for (;;) {
    const index = claimed;
    claimed += 1;
    if (index >= requests) return;

    const response = await fetch(endpoint);
    if (!response.ok) {
      throw new Error(`request ${index} returned ${response.status}`);
    }
    const body = JSON.parse(await response.text());
    values.push(body.value);
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
values.sort((left, right) => left - right);

const result = {
  requests,
  concurrency,
  unique: new Set(values).size,
  min: values[0],
  max: values.at(-1),
  contiguous: values.every((value, index) => value === index + 1),
};

console.log(JSON.stringify(result));
if (!result.contiguous || result.unique !== requests) process.exit(1);
