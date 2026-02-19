import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ==============================
// SUPABASE
// ==============================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ==============================
// FUNÇÃO GET OR CREATE CUSTOMER
// ==============================
async function getOrCreateCustomer(email) {
  let { data: customer } = await supabase
    .from("customers")
    .select("*")
    .eq("email", email)
    .single();

  if (!customer) {
    const { data } = await supabase
      .from("customers")
      .insert([
        {
          email,
          lifetime_total: 0,
          laser_total: 0,
          cashback_balance: 0,
          laser_tier: 0,
        },
      ])
      .select()
      .single();

    customer = data;
  }

  return customer;
}

// ==============================
// CORS
// ==============================
app.use(
  cors({
    origin: ["https://lltouch.com", "http://localhost:3000"],
  })
);

app.use(express.json());

// ==============================
// TABELA DE PREÇOS (Stripe Price IDs)
// ==============================
const priceMap = {
  membership: {
    platinum: { "6": "price_1SyuFlLVWAMw3iFeAAU7GR1e" },
    gold: { "6": "price_1SyuGnLVWAMw3iFe3U8Y81SF" },
    teen: { "6": "price_1SyuHuLVWAMw3iFetbcoodh2" },
  },

  laser: {
    small: {
      single: "price_1Sv2ExLVWAMw3iFedZ6vFjav",
      6: "price_1Sv2GKLVWAMw3iFeN9zMligM",
      8: "price_1Sv2GkLVWAMw3iFe5JQYNmyz",
    },
    medium: {
      single: "price_1Sv2IcLVWAMw3iFeoadLWZQa",
      6: "price_1Sv2JmLVWAMw3iFe7xLMmPow",
      8: "price_1Sv2KALVWAMw3iFen8mPo7yZ",
    },
    large: {
      single: "price_1Sv2M2LVWAMw3iFe3BavpQJO",
      6: "price_1Sv2MaLVWAMw3iFeHcHi1TLZ",
      8: "price_1Sv2N4LVWAMw3iFePan3vdsc",
    },
    xlarge: {
      single: "price_1Sv2NvLVWAMw3iFe73PwJ0u4",
      6: "price_1Sv2OwLVWAMw3iFeY7kKQSzl",
      8: "price_1Sv2PQLVWAMw3iFeYiWPlDxM",
    },
  },

  "full-body": {
    single: {
      none: "price_1SvmuWLVWAMw3iFe6G7zVtgQ",
      fullface: "price_1SvmwjLVWAMw3iFenlsJHaWU",
    },
    6: {
      none: "price_1SvmxsLVWAMw3iFe7DU1aRwk",
      fullface: "price_1Svn0ULVWAMw3iFebOifqGLa",
    },
    8: {
      none: "price_1Svn24LVWAMw3iFep1e0Mpmb",
      fullface: "price_1Svn2qLVWAMw3iFew7lsbArO",
    },
  },

  "ll-signature": {
    "single-none": "price_1StqevLVWAMw3iFer0kW5wBq",
    "single-led10": "price_1StqgqLVWAMw3iFe9k2tD5rT",
    "single-led20": "price_1StqhLLVWAMw3iFesS17pRjR",
    "single-peel": "price_1StqhlLVWAMw3iFemTTki7vK",
    "3-none": "price_1StqiCLVWAMw3iFePkaQpH6V",
    "3-led10": "price_1StqioLVWAMw3iFeAm59s0Xt",
    "3-led20": "price_1StqkXLVWAMw3iFeR7QiSc1x",
    "3-peel": "price_1StqkrLVWAMw3iFe4tjY3cFF",
  },

  "classic-deluxe": {
    "single-none": "price_1SuEXILVWAMw3iFeEzZhwlVJ",
    "single-led10": "price_1SuEYELVWAMw3iFefiIqcGFR",
    "single-led20": "price_1SuEYnLVWAMw3iFewE4dpv9l",
    "single-peel": "price_1SuEZPLVWAMw3iFe7tYRV0oU",
    "3-none": "price_1SuEbGLVWAMw3iFeeieTxip5",
    "3-led10": "price_1SuEc1LVWAMw3iFey3J96baH",
    "3-led20": "price_1SuEd6LVWAMw3iFebVOUfGLQ",
    "3-peel": "price_1SuEdmLVWAMw3iFeJLmbA2Q0",
  },

  "ll-teen": {
    "single-none": "price_1SuEejLVWAMw3iFedQAwSrU6",
    "single-led10": "price_1SuEfLLVWAMw3iFermWmmr34",
    "single-led20": "price_1SuEfvLVWAMw3iFe3kb7eqUJ",
    "single-peel": "price_1SuEgGLVWAMw3iFeVHNgvu91",
    "3-none": "price_1SuEgsLVWAMw3iFeILBNpjT1",
    "3-led10": "price_1SuEhaLVWAMw3iFew6XXmiTM",
    "3-led20": "price_1SuEi5LVWAMw3iFewusx6G2v",
    "3-peel": "price_1SuEiLLVWAMw3iFe8YD0gUZy",
  },

  "med-spa": {
    microneedling: {
      single: {
        none: "price_1SxA01LVWAMw3iFesKpaxZvz",
        exosomes: "price_1SxA0VLVWAMw3iFeDjB6cXS9",
        neck: "price_1SxA1bLVWAMw3iFeENwK7Pjo",
        "exo-neck": "price_1SxAu4LVWAMw3iFe0xzdQLj6",
      },
      3: {
        none: "price_1SxA2lLVWAMw3iFeOfMnlep9",
        exosomes: "price_1SxA3LLVWAMw3iFeJWCBn4w9",
        neck: "price_1SxA4pLVWAMw3iFekvmzRRtg",
        "exo-neck": "price_1SxAvcLVWAMw3iFemyVhJy70",
      },
    },
    llumigold: {
      single: {
        none: "price_1SxA5mLVWAMw3iFeifsFKOFW",
        exosomes: "price_1SxA6YLVWAMw3iFe3Rv6fPhS",
        neck: "price_1SxA7FLVWAMw3iFeBJydTb8W",
        "exo-neck": "price_1SxAwrLVWAMw3iFew3fsdrha",
      },
      3: {
        none: "price_1SxA85LVWAMw3iFeG1JZ19Lu",
        exosomes: "price_1SxA8eLVWAMw3iFeGKRTsEEX",
        neck: "price_1SxA9LLVWAMw3iFeShWxtdjh",
        "exo-neck": "price_1SxAy7LVWAMw3iFeS4ctcll6",
      },
    },
    "laser-facial": {
      single: { none: "price_1SxABRLVWAMw3iFe7vYyqaVW" },
      3: { none: "price_1SxAEuLVWAMw3iFeNSwQFrR5" },
    },
    "glow-up-laser-facial": {
      single: {
        none: "price_1SxAKsLVWAMw3iFeyKH4OSTl",
        decollete: "price_1SxASrLVWAMw3iFeieILAe3T",
        neck: "price_1SxATvLVWAMw3iFeu78Ak5Xr",
      },
      3: {
        none: "price_1SxAUjLVWAMw3iFeTVxGy05w",
        decollete: "price_1SxAVeLVWAMw3iFeXpnKTDlr",
        neck: "price_1SxAWsLVWAMw3iFesU5eyyWC",
      },
    },
    peel: {
      single: { none: "price_1Syx4ULVWAMw3iFevqsTAPJj" },
      3: { none: "price_1Syx58LVWAMw3iFe2rmfw0VF" },
    },
  },
};

// ==============================
// OUTROS SERVIÇOS (Other Services)
// ==============================
const otherServicesPrices = {
  nanoblading: "price_1Szi9tLVWAMw3iFeni0n26QU",
  "powder-brows": "price_1SziATLVWAMw3iFeJ8O37uOa",
  "top-eyeliner": "price_1SziBLLVWAMw3iFefsG4hGYu",
  "lip-blush": "price_1SziBtLVWAMw3iFeOlogbBw5",
  "combo-full-face": "price_1SziCULVWAMw3iFeKQ7lsdNk",
};

// ==============================
// ROTA DE CRIAÇÃO DE SESSÃO DE CHECKOUT
// ==============================
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { line_items, promoCode, categories, facialTotal, email } = req.body;

    // Busca ou cria cliente no Supabase
    const customer = await getOrCreateCustomer(email);

    // =========================
    // LÓGICA DE CUPONS E DESCONTOS
    // =========================
    const discounts = [];

    // 1️⃣ CUPOM PRIMEIRA COMPRA (PRIORIDADE MÁXIMA)
    if (promoCode === "promo_1T2B8qLVWAMw3iFeuDu7TgOB") {
      // Aplica para qualquer serviço
      discounts.push({ promotion_code: promoCode });
    }
    // 2️⃣ CUPONS ESPECÍFICOS (SÓ SE O PRODUTO ESTIVER NO CARRINHO)
    else if (promoCode === "promo_1T2C4eLVWAMw3iFelFs4ILhS") {
      // MedSpa Microneedling (price específico)
      const hasMicroneedling = line_items.some(
        (item) => item.price === "price_1SxA01LVWAMw3iFesKpaxZvz"
      );

      if (hasMicroneedling) {
        discounts.push({ promotion_code: promoCode });
      }
    } else if (promoCode === "promo_1T2C35LVWAMw3iFeaHNr796B") {
      // Membership Platinum
      const hasPlatinum = line_items.some(
        (item) => item.price === "price_1SyuFlLVWAMw3iFeAAU7GR1e"
      );

      if (hasPlatinum) {
        discounts.push({ promotion_code: promoCode });
      }
    } else if (promoCode === "promo_1T2C1jLVWAMw3iFekFFK21u4") {
      // Other Services - Full Face
      const hasFullFace = line_items.some(
        (item) => item.price === "price_1SziCULVWAMw3iFeKQ7lsdNk"
      );

      if (hasFullFace) {
        discounts.push({ promotion_code: promoCode });
      }
    }
    // 3️⃣ DESCONTO AUTOMÁTICO FACIAL (SE NÃO HOUVER CUPOM MANUAL)
    else {
      let discountPercent = 0;

      if (facialTotal >= 1500 * 100) discountPercent = 10;
      else if (facialTotal >= 600 * 100) discountPercent = 7;
      else if (facialTotal >= 300 * 100) discountPercent = 5;

      if (discountPercent > 0) {
        const couponMap = {
          5: "pvJpxT7h",
          7: "qQVDq1Hd",
          10: "BNKguNqk",
        };

        discounts.push({ coupon: couponMap[discountPercent] });
      }
    }

    // =========================
    // CRIAR SESSÃO STRIPE
    // =========================
    const sessionData = {
      mode: "payment",
      customer: customer?.id,
      line_items,
      metadata: { categories: JSON.stringify(categories) },
      success_url:
        "https://lltouch.com/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://lltouch.com/cancel",
    };

    if (discounts.length > 0) {
      sessionData.discounts = discounts;
    }

    const session = await stripe.checkout.sessions.create(sessionData);

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ==============================
// WEBHOOK STRIPE
// ==============================
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.log("Webhook signature verification failed.", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = await stripe.checkout.sessions.retrieve(
        event.data.object.id,
        { expand: ["line_items.data.price"] }
      );

      const email = session.customer_details?.email;
      if (!email) return res.json({ received: true });

      const total = session.amount_total / 100;
      const categories = JSON.parse(session.metadata?.categories || "[]");

      const customer = await getOrCreateCustomer(email);

      // =========================
      // CALCULAR TOTAL POR CATEGORIA
      // =========================
      let laserTotal = 0;
      let facialTotal = 0;

      session.line_items.data.forEach((item) => {
        const category = item.price.metadata?.category;
        const amount = item.amount_total / 100;

        if (category === "laser") laserTotal += amount;
        if (category === "facial") facialTotal += amount;
      });

      // =========================
      // ATUALIZA LIFETIME
      // =========================
      await supabase
        .from("customers")
        .update({
          lifetime_total: (customer.lifetime_total || 0) + total,
        })
        .eq("email", email);

      // =========================
      // LASER CASHBACK
      // =========================
      if (laserTotal > 0) {
        const newLaserTotal = (customer.laser_total || 0) + laserTotal;

        let tier = 0;
        if (newLaserTotal >= 3000) tier = 10;
        else if (newLaserTotal >= 1500) tier = 7;
        else if (newLaserTotal >= 500) tier = 5;

        const cashbackEarned = (laserTotal * tier) / 100;

        await supabase
          .from("customers")
          .update({
            laser_total: newLaserTotal,
            laser_tier: tier,
            cashback_balance: (customer.cashback_balance || 0) + cashbackEarned,
          })
          .eq("email", email);

        await supabase.from("cashback_transactions").insert([
          {
            email,
            amount: cashbackEarned,
            type: "earned",
            source: "laser purchase",
          },
        ]);
      }

      // =========================
      // FACIAL DESCONTO PROGRESSIVO
      // =========================
      if (facialTotal > 0) {
        let discountTier = 0;
        if (facialTotal >= 1500) discountTier = 10;
        else if (facialTotal >= 600) discountTier = 7;
        else if (facialTotal >= 300) discountTier = 5;

        await supabase
          .from("customers")
          .update({
            facial_discount_next: discountTier,
          })
          .eq("email", email);
      }

      console.log(`Checkout processed for: ${email}`);
    }

    res.json({ received: true });
  }
);

app.get("/", (_, res) => res.send("Stripe API running 🚀"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
