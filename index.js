import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

// ✅ Inicializa o Stripe com a chave secreta
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ✅ Middlewares
app.use(cors());
app.use(express.json());

/* ==============================
  ✅ Rota raiz (teste de vida)
============================== */
app.get("/", (req, res) => {
  res.send("API Stripe Checkout funcionando 🚀");
});

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
        unit_amount: Math.round(item.price * 100) // Stripe usa centavos
      },
      quantity: item.quantity
    }));

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      success_url: "https://lltouch.com/success",
      cancel_url: "https://lltouch.com/cancel",
      locale: "en"
    });

    res.json({ url: session.url });

  } catch (error) {
    console.error("Stripe error:", error);
    res.status(500).json({ error: "Error creating checkout session" });
  }
});

/* ==============================
  2️⃣ Start Server (Render)
============================== */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
