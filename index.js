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
    platinum: {
      "6": "price_1SyuFlLVWAMw3iFeAAU7GR1e"
    },
    gold: {
      "6": "price_1SyuGnLVWAMw3iFe3U8Y81SF"
    },
    teen: {
      "6": "price_1SyuHuLVWAMw3iFetbcoodh2"
    }
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
  "ll-signature": {
    "single-none": "price_1StqevLVWAMw3iFer0kW5wBq",
    "single-led10": "price_1StqgqLVWAMw3iFe9k2tD5rT",
    "single-led20": "price_1StqhLLVWAMw3iFesS17pRjR",
    "single-peel": "price_1StqhlLVWAMw3iFemTTki7vK",
    "3-none": "price_1StqiCLVWAMw3iFePkaQpH6V",
    "3-led10": "price_1StqioLVWAMw3iFeAm59s0Xt",
    "3-led20": "price_1StqkXLVWAMw3iFeR7QiSc1x",
    "3-peel": "price_1SxrmDLVWAMw3iFeLxauW07O"
  },
  "classic-deluxe": {
    "single-none": "price_1SuEXILVWAMw3iFeEzZhwlVJ",
    "single-led10": "price_1SuEYELVWAMw3iFefiIqcGFR",
    "single-led20": "price_1SuEYnLVWAMw3iFewE4dpv9l",
    "single-peel": "price_1SuEZPLVWAMw3iFe7tYRV0oU",
    "3-none": "price_1SuEbGLVWAMw3iFeeieTxip5",
    "3-led10": "price_1SuEc1LVWAMw3iFey3J96baH",
    "3-led20": "price_1SuEd6LVWAMw3iFebVOUfGLQ",
    "3-peel": "price_1SuEdmLVWAMw3iFeJLmbA2Q0"
  },
  "ll-teen": {
    "single-none": "price_1SuEejLVWAMw3iFedQAwSrU6",
    "single-led10": "price_1SuEfLLVWAMw3iFermWmmr34",
    "single-led20": "price_1SuEfvLVWAMw3iFe3kb7eqUJ",
    "single-peel": "price_1SuEgGLVWAMw3iFeVHNgvu91",
    "3-none": "price_1SuEgsLVWAMw3iFeILBNpjT1",
    "3-led10": "price_1SuEhaLVWAMw3iFew6XXmiTM",
    "3-led20": "price_1SuEi5LVWAMw3iFewusx6G2v",
    "3-peel": "price_1SuEiLLVWAMw3iFe8YD0gUZy"
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
    },
    llumigold: {
      single: {
        none: "price_1SxA5mLVWAMw3iFeifsFKOFW",
        exosomes: "price_1SxA6YLVWAMw3iFe3Rv6fPhS",
        neck: "price_1SxA7FLVWAMw3iFeBJydTb8W",
        "exo-neck": "price_1SxAwrLVWAMw3iFew3fsdrha"
      },
      3: {
        none: "price_1SxA85LVWAMw3iFeG1JZ19Lu",
        exosomes: "price_1SxA8eLVWAMw3iFeGKRTsEEX",
        neck: "price_1SxA9LLVWAMw3iFeShWxtdjh",
        "exo-neck": "price_1SxAy7LVWAMw3iFeS4ctcll6"
      }
    },
    "laser-facial": {
      single: {
        none: "price_1SxABRLVWAMw3iFe7vYyqaVW"
      },
      3: {
        none: "price_1SxAEuLVWAMw3iFeNSwQFrR5"
      }
    },
    "glow-up-laser-facial": {
      single: {
        none: "price_1SxAKsLVWAMw3iFeyKH4OSTl",
        decollete: "price_1SxASrLVWAMw3iFeieILAe3T",
        neck: "price_1SxATvLVWAMw3iFeu78Ak5Xr"
      },
      3: {
        none: "price_1SxAUjLVWAMw3iFeTVxGy05w",
        decollete: "price_1SxAVeLVWAMw3iFeXpnKTDlr",
        neck: "price_1SxAWsLVWAMw3iFesU5eyyWC"
      }
    },
    "peel": {
      single: {
        none: "price_1Syx4ULVWAMw3iFevqsTAPJj"
      },
      3: {
        none: "price_1Syx58LVWAMw3iFe2rmfw0VF"
    }
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

  if (item.type === "facial") {
    const price = priceMap?.[item.service]?.[item.key];
    if (!price) throw new Error("Invalid facial item");
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

  // ✅ Novo bloco membership
  if (item.type === "membership") {
    const price = priceMap.membership?.[item.plan]?.[item.package];
    if (!price) throw new Error("Invalid membership item");
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
  ROTA PARA CONFIRMAÇÃO DE PAGAMENTO
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
