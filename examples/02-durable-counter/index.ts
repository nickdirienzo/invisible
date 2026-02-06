import express from "express";

const counters = new Map<string, number>();

const app = express();
const port = process.env.PORT || 3000;

app.get("/:key", async (req, res) => {
  const key = req.params.key;
  const current = (await counters.get(key)) ?? 0;
  const next = current + 1;
  await counters.set(key, next);
  res.json({ key, count: next });
});

app.listen(port, () => {
  console.log(`Listening on http://localhost:${port}`);
});
