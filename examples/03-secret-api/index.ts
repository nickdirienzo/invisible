import express from "express";

const app = express();
const port = process.env.PORT || 3000;

app.get("/charge", async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  // In a real app, this would call the Stripe API
  res.json({ charged: true, keyPresent: !!stripeKey });
});

app.get("/notify", async (req, res) => {
  const sendgridKey = process.env.SENDGRID_API_KEY;
  // In a real app, this would send an email via SendGrid
  res.json({ notified: true, keyPresent: !!sendgridKey });
});

app.listen(port, () => {
  console.log(`Listening on http://localhost:${port}`);
});
