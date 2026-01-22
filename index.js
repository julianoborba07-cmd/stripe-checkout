import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

// ✅ Inicializa Stripe com chave secreta
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ✅ Middlewares
app.use(cors({
  origin: ["https://lltouch.com", "http://localhost:3000"] // seu site + testes locais
}));
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

    // Mapeia itens para o formato Stripe
    const line_items = items.map(item => ({
      price_data: {
        currency: "usd", // Moeda em USD
        product_data: {
          name: item.name,
          description: item.description || ""
        },
        unit_amount: Math.round(item.price * 100) // converte para centavos
      },
      quantity: item.quantity
    }));

    // Cria sessão de checkout
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      success_url: "https://lltouch.com/success",
      cancel_url: "https://lltouch.com/cancel",
      locale: "en"
    });

    // Retorna URL para redirecionamento
    res.json({ url: session.url });

  } catch (error) {
    console.error("Stripe error:", error);
    res.status(500).json({ error: "Error creating checkout session" });
  }
});

/* ==============================
  2️⃣ Start Server
============================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
