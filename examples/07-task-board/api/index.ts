import { EventEmitter } from "node:events";
import express from "express";

const app = express();
const port = process.env.PORT || 4000;

// Durable state — module-scope Maps backed by Valkey at deploy time
const tasks = new Map<string, { title: string; column: string; boardId: string; createdAt: string }>();
const boards = new Map<string, { name: string; createdAt: string }>();

// Secrets — fetched from OpenBao at deploy time
const webhookUrl = process.env.WEBHOOK_URL;
const adminToken = process.env.ADMIN_TOKEN;

// Events — distributed via Dapr pub/sub at deploy time
const taskEvents = new EventEmitter();

taskEvents.on("task:created", (data) => {
  console.log(`Task created: ${JSON.stringify(data)}`);
});

taskEvents.on("task:completed", (data) => {
  console.log(`Task completed: ${JSON.stringify(data)}`);
});

taskEvents.on("task:moved", (data) => {
  console.log(`Task moved: ${JSON.stringify(data)}`);
});

// Cron job — runs cleanup every 30 seconds via Dapr scheduler at deploy time
setInterval(() => {
  fetch("/api/cleanup", { method: "POST" });
}, 30 * 1000);

app.use(express.json());
app.use((_req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (_req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

// Board endpoints
app.post("/api/boards", async (req, res) => {
  const id = crypto.randomUUID();
  const board = { name: req.body.name, createdAt: new Date().toISOString() };
  await boards.set(id, board);
  res.json({ id, ...board });
});

app.get("/api/boards", async (_req, res) => {
  const result: Array<{ id: string; name: string; createdAt: string }> = [];
  for (const [id, board] of await boards.entries()) {
    result.push({ id, ...board });
  }
  res.json(result);
});

// Task endpoints
app.get("/api/boards/:boardId/tasks", async (req, res) => {
  const result: Array<{ id: string; title: string; column: string; boardId: string; createdAt: string }> = [];
  for (const [id, task] of await tasks.entries()) {
    if (task.boardId === req.params.boardId) {
      result.push({ id, ...task });
    }
  }
  res.json(result);
});

app.post("/api/boards/:boardId/tasks", async (req, res) => {
  const id = crypto.randomUUID();
  const task = {
    title: req.body.title,
    column: "todo",
    boardId: req.params.boardId,
    createdAt: new Date().toISOString(),
  };
  await tasks.set(id, task);
  taskEvents.emit("task:created", { id, ...task });
  res.json({ id, ...task });
});

app.patch("/api/tasks/:taskId", async (req, res) => {
  const task = await tasks.get(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: "not found" });
    return;
  }

  const prevColumn = task.column;
  const updated = { ...task, ...req.body };
  await tasks.set(req.params.taskId, updated);

  if (updated.column === "done" && prevColumn !== "done") {
    taskEvents.emit("task:completed", { id: req.params.taskId, ...updated });
  } else if (updated.column !== prevColumn) {
    taskEvents.emit("task:moved", { id: req.params.taskId, from: prevColumn, to: updated.column });
  }

  res.json({ id: req.params.taskId, ...updated });
});

app.delete("/api/tasks/:taskId", async (req, res) => {
  const deleted = await tasks.delete(req.params.taskId);
  res.json({ deleted });
});

// Cleanup endpoint (called by cron job)
app.post("/api/cleanup", async (_req, res) => {
  let archived = 0;
  for (const [id, task] of await tasks.entries()) {
    if (task.column === "done") {
      const age = Date.now() - new Date(task.createdAt).getTime();
      if (age > 30 * 24 * 60 * 60 * 1000) {
        await tasks.delete(id);
        archived++;
      }
    }
  }
  console.log(`Cleanup: archived ${archived} completed tasks`);
  res.json({ archived });
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", webhookConfigured: !!webhookUrl, adminConfigured: !!adminToken });
});

app.listen(port, () => {
  console.log(`Task Board API listening on http://localhost:${port}`);
});
