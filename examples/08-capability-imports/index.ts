import express from "express";
import { Pool } from "pg";
import { createClient } from "redis";

const app = express();
const port = process.env.PORT || 3000;

// PostgreSQL — capability-import detects "pg" as relational/postgres (replace).
// II will provision a PostgreSQL instance.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Redis — capability-import detects "redis" as kv/valkey (replace).
// II will provision a Valkey instance.
const cache = createClient({ url: process.env.REDIS_URL });

app.get("/users", async (req, res) => {
  const cacheKey = "users:all";
  const cached = await cache.get(cacheKey);
  if (cached) {
    return res.json(JSON.parse(cached));
  }

  const { rows } = await pool.query("SELECT id, name, email FROM users");
  await cache.set(cacheKey, JSON.stringify(rows), { EX: 60 });
  res.json(rows);
});

app.get("/users/:id", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});

app.listen(port, () => {
  console.log(`Listening on http://localhost:${port}`);
});
