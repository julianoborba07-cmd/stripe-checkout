import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors({
  origin: ["https://lltouch.com", "http://localhost:3000"]
}));
app.use(express.json());

/* ==============================
  TABELA DE PREÇOS (Stripe Price IDs)
============================== */
const PRICE_TABLE = {
  "single-none": "price_1StqevLVWAMw3iFer0kW5wBq",
  "single-led10": "price_1StqgqLVWAMw3iFe9k2tD5rT",
  "single-led20": "price_1StqhLLVWAMw3iFesS17pRjR",
  "single-peel": "price_1StqhlLVWAMw3iFemTTki7vK",
  "3-none": "price_1StqiCLVWAMw3iFePkaQpH6V",
  "3-led10": "price_1StioLVWAMw3iFeAm59s0Xt",
  "3-led20": "price_1StqkXLVWAMw3iFeR7QiSc1x",
  "3-peel": "price_1StqkrLVWAMw3iFe4tjY3cFF"
};

/* ==============================
  ROTA DE CHECKOUT (MULTI-ITEM)
============================== */
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { items } = req.body; // espera array [{ packageId, addonId, quantity }]

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items provided" });
    }

    // Mapear itens do carrinho para line_items usando Price IDs
    const line_items = items.map(item => {
      const key = `${item.packageId}-${item.addonId}`;
      const priceId = PRICE_TABLE[key];

      if (!priceId) throw new Error(`Invalid item key: ${key}`);

      return {
        price: priceId,
        quantity: item.quantity || 1
      };
    });

    // Criar sessão de checkout Stripe
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      success_url: "https://lltouch.com/success",
      cancel_url: "https://lltouch.com/cancel"
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Stripe error" });
  }
});

app.get("/", (_, res) => res.send("Stripe API running 🚀"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
