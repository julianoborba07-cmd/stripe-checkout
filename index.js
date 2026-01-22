// ==============================
// IMPORTS & CONFIG
// ==============================
import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ==============================
// MIDDLEWARES
// ==============================
app.use(cors({
  origin: ["https://lltouch.com", "http://localhost:3000"]
}));
app.use(express.json());

// ==============================
// TABELA DE PREÇOS (ÚNICA FONTE)
// Valores em CENTAVOS
// ==============================
const PRICE_TABLE = {
  single: {
    name: "LL Signature – Single Session",
    price: 16500
  },
  three: {
    name: "LL Signature – 3 Sessions",
    price: 46500
  },
  addons: {
    none: null,
    led10: { name: "LED (10 min)", price: 3000 },
    led20: { name: "LED (20 min)", price: 5000 },
    peel: { name: "Peel", price: 6500 }
  }
};

// ==============================
// ROTA DE CHECKOUT UNIFICADA
// ==============================
app.post("/create-checkout-session", async (req, res) => {
  try {
    // ============================
    // MODO TESTE (apenas para validar botão)
    // ============================
    if (req.body.test) {
      return res.json({ url: "https://stripe.com" });
    }

    // ============================
    // Backend real (package + addon)
    // ============================
    const { packageId, addonId, items } = req.body;

    let line_items = [];

    // ============================
    // Se enviar items (carrinho real Webflow)
    // ============================
    if (items && Array.isArray(items)) {
      line_items = items.map(item => ({
        price_data: {
          currency: "usd",
          product_data: { name: item.name },
          unit_amount: item.price
        },
        quantity: item.quantity || 1
      }));
    } else {
      // fallback: package + addonId
      if (!PRICE_TABLE[packageId]) {
        return res.status(400).json({ error: "Invalid package" });
      }

      line_items.push({
        price_data: {
          currency: "usd",
          product_data: { name: PRICE_TABLE[packageId].name },
          unit_amount: PRICE_TABLE[packageId].price
        },
        quantity: 1
      });

      if (addonId && addonId !== "none") {
        const addon = PRICE_TABLE.addons[addonId];
        if (!addon) {
          return res.status(400).json({ error: "Invalid addon" });
        }

        line_items.push({
          price_data: {
            currency: "usd",
            product_data: { name: addon.name },
            unit_amount: addon.price
          },
          quantity: 1
        });
      }
    }

    // ============================
    // CRIA SESSÃO DO STRIPE
    // ============================
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      success_url: "https://lltouch.com/success",
      cancel_url: "https://lltouch.com/cancel"
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Stripe error" });
  }
});

// ==============================
// ROTA ROOT
// ==============================
app.get("/", (_, res) => {
  res.send("Stripe API running 🚀");
});

// ==============================
// START SERVER
// ==============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
