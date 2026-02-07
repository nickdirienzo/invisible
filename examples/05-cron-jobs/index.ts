import express from "express";

const app = express();
const port = process.env.PORT || 3000;

// Durable: report endpoint called every 24 hours
// Any local path works — II proxies via the internal server
setInterval(() => {
  fetch("/api/daily-report", { method: "POST" });
}, 24 * 60 * 60 * 1000);

// Durable: cleanup endpoint called every hour
setInterval(() => {
  fetch("/api/cleanup", { method: "POST" });
}, 3600000);

// Durable: sync endpoint called every minute
setInterval(() => {
  fetch("/api/sync", { method: "POST" });
}, 60 * 1000);

// Ephemeral: inline logic stays in-process
setInterval(() => {
  console.log(`[${new Date().toISOString()}] heartbeat`);
}, 30000);

app.post("/api/daily-report", (req, res) => {
  console.log("Generating daily report...");
  // In a real app: query DB, build report, send email
  res.json({ status: "report sent" });
});

app.post("/api/cleanup", (req, res) => {
  console.log("Running cleanup...");
  // In a real app: purge expired sessions, archive old data
  res.json({ status: "cleanup complete" });
});

app.post("/api/sync", (req, res) => {
  console.log("Running sync...");
  res.json({ status: "sync complete" });
});

app.get("/", (req, res) => {
  res.json({ service: "cron-jobs", status: "running" });
});

app.listen(port, () => {
  console.log(`Listening on http://localhost:${port}`);
});
