import { EventEmitter } from "node:events";
import express from "express";

const app = express();
const port = process.env.PORT || 3000;

// Durable: module-scope EventEmitter → distributed pub/sub via Dapr
const orders = new EventEmitter();

orders.on("order:created", (data) => {
  console.log(`New order: ${JSON.stringify(data)}`);
  // In a real app: send confirmation email, update inventory
});

orders.on("order:shipped", (data) => {
  console.log(`Order shipped: ${JSON.stringify(data)}`);
  // In a real app: send shipping notification
});

orders.once("order:cancelled", (data) => {
  console.log(`Order cancelled: ${JSON.stringify(data)}`);
});

app.use(express.json());

app.post("/orders", (req, res) => {
  const order = { id: Date.now(), ...req.body };
  orders.emit("order:created", order);
  res.json({ status: "created", order });
});

app.post("/orders/:id/ship", (req, res) => {
  orders.emit("order:shipped", { id: req.params.id });
  res.json({ status: "shipped" });
});

app.post("/orders/:id/cancel", (req, res) => {
  orders.emit("order:cancelled", { id: req.params.id });
  res.json({ status: "cancelled" });
});

app.get("/", (req, res) => {
  res.json({ service: "events-example", status: "running" });
});

app.listen(port, () => {
  console.log(`Listening on http://localhost:${port}`);
});
