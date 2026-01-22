import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors());
app.use(express.json());

/* ==============================
  1️⃣ Create Stripe Checkout Session
============================== */
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { items } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const line_items = items.map(item => ({
      price_data: {
        currency: "eur",
        product_data: {
          name: item.name,
          description: item.description || ""
        },
        unit_amount: Math.round(item.price * 100) // Stripe expects cents
      },
      quantity: item.quantity
    }));

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: line_items,
      success_url: "https://lltouch.com/success",
      cancel_url: "https://lltouch.com/cancel",
      locale: "en" // checkout in English
    });

    res.json({ url: session.url });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error creating checkout session" });
  }
});

/* ==============================
  2️⃣ Start Server
============================== */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});