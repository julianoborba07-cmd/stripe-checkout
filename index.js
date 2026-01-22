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
  TABELA DE PREÇOS (ÚNICA FONTE)
  valores em CENTAVOS
============================== */
const PRICE_TABLE = {
  "single": { name: "LL Signature – Single Session", price: 16500 },
  "three": { name: "LL Signature – 3 Sessions", price: 46500 },
  addons: {
    none: null,
    led10: { name: "LED (10 min)", price: 3000 },
    led20: { name: "LED (20 min)", price: 5000 },
    peel: { name: "Peel", price: 6500 }
  }
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

    const line_items = [];

    // Processa cada item do carrinho
    items.forEach(item => {
      const { packageId, addonId, quantity } = item;

      if (!PRICE_TABLE[packageId]) throw new Error(`Invalid package: ${packageId}`);

      // Pacote
      line_items.push({
        price_data: {
          currency: "usd",
          product_data: { name: PRICE_TABLE[packageId].name },
          unit_amount: PRICE_TABLE[packageId].price
        },
        quantity: quantity || 1
      });

      // Add-on
      if (addonId && addonId !== "none") {
        const addon = PRICE_TABLE.addons[addonId];
        if (!addon) throw new Error(`Invalid addon: ${addonId}`);

        line_items.push({
          price_data: {
            currency: "usd",
            product_data: { name: addon.name },
            unit_amount: addon.price
          },
          quantity: quantity || 1
        });
      }
    });

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
