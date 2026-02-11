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
const priceMap = {

  membership: {
    platinum: { "6": "price_1SyuFlLVWAMw3iFeAAU7GR1e" },
    gold: { "6": "price_1SyuGnLVWAMw3iFe3U8Y81SF" },
    teen: { "6": "price_1SyuHuLVWAMw3iFetbcoodh2" }
  },

  laser: {
    small: {
      single: "price_1Sv2ExLVWAMw3iFedZ6vFjav",
      6: "price_1Sv2GKLVWAMw3iFeN9zMligM",
      8: "price_1Sv2GkLVWAMw3iFe5JQYNmyz"
    },
    medium: {
      single: "price_1Sv2IcLVWAMw3iFeoadLWZQa",
      6: "price_1Sv2JmLVWAMw3iFe7xLMmPow",
      8: "price_1Sv2KALVWAMw3iFen8mPo7yZ"
    },
    large: {
      single: "price_1Sv2M2LVWAMw3iFe3BavpQJO",
      6: "price_1Sv2MaLVWAMw3iFeHcHi1TLZ",
      8: "price_1Sv2N4LVWAMw3iFePan3vdsc"
    },
    xlarge: {
      single: "price_1Sv2NvLVWAMw3iFe73PwJ0u4",
      6: "price_1Sv2OwLVWAMw3iFeY7kKQSzl",
      8: "price_1Sv2PQLVWAMw3iFeYiWPlDxM"
    }
  },

  "full-body": {
    single: {
      none: "price_1SvmuWLVWAMw3iFe6G7zVtgQ",
      fullface: "price_1SvmwjLVWAMw3iFenlsJHaWU"
    },
    6: {
      none: "price_1SvmxsLVWAMw3iFe7DU1aRwk",
      fullface: "price_1Svn0ULVWAMw3iFebOifqGLa"
    },
    8: {
      none: "price_1Svn24LVWAMw3iFep1e0Mpmb",
      fullface: "price_1Svn2qLVWAMw3iFew7lsbArO"
    }
  },

  "med-spa": {
    microneedling: {
      single: {
        none: "price_1SxA01LVWAMw3iFesKpaxZvz",
        exosomes: "price_1SxA0VLVWAMw3iFeDjB6cXS9",
        neck: "price_1SxA1bLVWAMw3iFeENwK7Pjo",
        "exo-neck": "price_1SxAu4LVWAMw3iFe0xzdQLj6"
      },
      3: {
        none: "price_1SxA2lLVWAMw3iFeOfMnlep9",
        exosomes: "price_1SxA3LLVWAMw3iFeJWCBn4w9",
        neck: "price_1SxA4pLVWAMw3iFekvmzRRtg",
        "exo-neck": "price_1SxAvcLVWAMw3iFemyVhJy70"
      }
    }
  },

  /* ✅ NOVO BLOCO OTHER SERVICES */
  "other-service": {
    "nanoblading": "price_1Szi9tLVWAMw3iFeni0n26QU",
    "powder-brows": "price_1SziATLVWAMw3iFeJ8O37uOa",
    "top-eyeliner": "price_1SziBLLVWAMw3iFefsG4hGYu",
    "lip-blush": "price_1SziBtLVWAMw3iFeOlogbBw5",
    "combo-full-face": "price_1SziCULVWAMw3iFeKQ7lsdNk"
  }
};


/* ==============================
   ROTA DE CHECKOUT
============================== */
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items provided" });
    }

    const line_items = items.map(item => {

      if (item.type === "laser") {
        const price = priceMap.laser?.[item.area]?.[item.package];
        if (!price) throw new Error("Invalid laser item");
        return { price, quantity: item.quantity };
      }

      if (item.type === "full-body") {
        const price = priceMap["full-body"]?.[item.package]?.[item.addon || "none"];
        if (!price) throw new Error("Invalid full body item");
        return { price, quantity: item.quantity };
      }

      if (item.type === "med-spa") {
        const price = priceMap["med-spa"]?.[item.service]?.[item.package]?.[item.addon];
        if (!price) throw new Error("Invalid med-spa item");
        return { price, quantity: item.quantity };
      }

      if (item.type === "membership") {
        const price = priceMap.membership?.[item.plan]?.[item.package];
        if (!price) throw new Error("Invalid membership item");
        return { price, quantity: item.quantity };
      }

      /* ✅ NOVO BLOCO OTHER SERVICES */
      if (item.type === "other-service") {
        const price = priceMap["other-service"]?.[item.serviceKey];
        if (!price) throw new Error("Invalid other service item");
        return { price, quantity: item.quantity };
      }

      throw new Error("Invalid item type");
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      success_url: "https://lltouch.com/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://lltouch.com/cancel"
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


/* ==============================
   CONFIRMAÇÃO DE PAGAMENTO
============================== */
app.get("/checkout-session/:sessionId", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(
      req.params.sessionId,
      { expand: ["line_items.data.price.product"] }
    );

    if (session.payment_status !== "paid") {
      return res.status(400).json({ error: "Pagamento não confirmado" });
    }

    const items = session.line_items.data.map(item => ({
      name: item.price.product.name,
      description: item.price.product.description,
      quantity: item.quantity,
      amount: item.amount_total / 100
    }));

    res.json({
      id: session.id,
      email: session.customer_details?.email,
      total: session.amount_total / 100,
      items
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar sessão" });
  }
});


/* ==============================
   ROTA TESTE
============================== */
app.get("/", (_, res) => res.send("Stripe API running 🚀"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));

