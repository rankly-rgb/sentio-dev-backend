require("dotenv").config({ path: ".env.local" });

const express = require("express");
const Stripe = require("stripe");
const bodyParser = require("body-parser");
const { createClient } = require("@supabase/supabase-js");
const hubspot = require("@hubspot/api-client");

// --- Clients ---

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const hubspotClient = new hubspot.Client({
  accessToken: process.env.HUBSPOT_API_KEY,
});

// --- App ---

const app = express();

app.use(bodyParser.raw({ type: "application/json" }));

app.get("/", (req, res) => {
  res.send("Server running");
});

app.post("/api/webhook/stripe", (req, res) => {
  console.log("Stripe webhook received");
  res.json({ received: true });
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});

module.exports = { supabase, stripe, hubspotClient };
