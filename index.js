import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import rateLimit from "express-rate-limit";

dotenv.config();

// ==============================
// SECURITY CONFIG
// ==============================

const VALID_TYPES = [
  "laser",
  "full-body",
  "facial",
  "membership",
  "med-spa",
  "morpheus",
  "other-service"
];

const MAX_CART_ITEMS = 20;
const MAX_ITEM_QUANTITY = 10;

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

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
// GET OR CREATE CUSTOMER
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
      .insert([{
        email,
        lifetime_total: 0,
        laser_total: 0,
        laser_tier: 0,
        cashback_balance: 0,
        first_purchase_used: false,
        microneedling_discount_used: false,
        facial_total: 0,
        facial_discount_next: 0,
        popup_unlocked: false  // Inicia bloqueado
      }])
      .select()
      .single();

    customer = data;
  }

  return customer;
}

// ==============================
// CORS
// ==============================
app.use(cors({
  origin: [
  "https://lltouch.com",
  "https://www.lltouch.com"
]
}));
app.use(express.json());

// ==============================
// RATE LIMIT (CHECKOUT PROTECTION)
// ==============================

const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 50, // 50 requisições por IP
  message: { error: "Too many requests. Try again later." }
});

app.use("/create-checkout-session", checkoutLimiter);

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
    small: { single: "price_1Sv2ExLVWAMw3iFedZ6vFjav", 6: "price_1Sv2GKLVWAMw3iFeN9zMligM", 8: "price_1Sv2GkLVWAMw3iFe5JQYNmyz" },
    medium: { single: "price_1Sv2IcLVWAMw3iFeoadLWZQa", 6: "price_1Sv2JmLVWAMw3iFe7xLMmPow", 8: "price_1Sv2KALVWAMw3iFen8mPo7yZ" },
    large: { single: "price_1Sv2M2LVWAMw3iFe3BavpQJO", 6: "price_1Sv2MaLVWAMw3iFeHcHi1TLZ", 8: "price_1Sv2N4LVWAMw3iFePan3vdsc" },
    xlarge: { single: "price_1Sv2NvLVWAMw3iFe73PwJ0u4", 6: "price_1Sv2OwLVWAMw3iFeY7kKQSzl", 8: "price_1Sv2PQLVWAMw3iFeYiWPlDxM" },
  },
  "full-body": {
    single: { none: "price_1SvmuWLVWAMw3iFe6G7zVtgQ", fullface: "price_1SvmwjLVWAMw3iFenlsJHaWU" },
    6: { none: "price_1SvmxsLVWAMw3iFe7DU1aRwk", fullface: "price_1Svn0ULVWAMw3iFebOifqGLa" },
    8: { none: "price_1Svn24LVWAMw3iFep1e0Mpmb", fullface: "price_1Svn2qLVWAMw3iFew7lsbArO" },
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
      single: { none: "price_1SxA01LVWAMw3iFesKpaxZvz", exosomes: "price_1SxA0VLVWAMw3iFeDjB6cXS9", neck: "price_1SxA1bLVWAMw3iFeENwK7Pjo", "exo-neck": "price_1SxAu4LVWAMw3iFe0xzdQLj6" },
      3: { none: "price_1SxA2lLVWAMw3iFeOfMnlep9", exosomes: "price_1SxA3LLVWAMw3iFeJWCBn4w9", neck: "price_1SxA4pLVWAMw3iFekvmzRRtg", "exo-neck": "price_1SxAvcLVWAMw3iFemyVhJy70" },
    },
    llumigold: {
      single: { none: "price_1SxA5mLVWAMw3iFeifsFKOFW", exosomes: "price_1SxA6YLVWAMw3iFe3Rv6fPhS", neck: "price_1SxA7FLVWAMw3iFeBJydTb8W", "exo-neck": "price_1SxAwrLVWAMw3iFew3fsdrha" },
      3: { none: "price_1SxA85LVWAMw3iFeG1JZ19Lu", exosomes: "price_1SxA8eLVWAMw3iFeGKRTsEEX", neck: "price_1SxA9LLVWAMw3iFeShWxtdjh", "exo-neck": "price_1SxAy7LVWAMw3iFeS4ctcll6" },
    },
    "laser-facial": { single: { none: "price_1SxABRLVWAMw3iFe7vYyqaVW" }, 3: { none: "price_1SxAEuLVWAMw3iFeNSwQFrR5" } },
    "glow-up-laser-facial": { single: { none: "price_1SxAKsLVWAMw3iFeyKH4OSTl", decollete: "price_1SxASrLVWAMw3iFeieILAe3T", neck: "price_1SxATvLVWAMw3iFeu78Ak5Xr" }, 3: { none: "price_1SxAUjLVWAMw3iFeTVxGy05w", decollete: "price_1SxAVeLVWAMw3iFeXpnKTDlr", neck: "price_1SxAWsLVWAMw3iFesU5eyyWC" } },
    peel: { single: { none: "price_1Syx4ULVWAMw3iFevqsTAPJj" }, 3: { none: "price_1Syx58LVWAMw3iFe2rmfw0VF" } },
  },
};

const otherServicesPrices = {
  nanoblading: "price_1Szi9tLVWAMw3iFeni0n26QU",
  "powder-brows": "price_1SziATLVWAMw3iFeJ8O37uOa",
  "top-eyeliner": "price_1SziBLLVWAMw3iFefsG4hGYu",
  "lip-blush": "price_1SziBtLVWAMw3iFeOlogbBw5",
  "combo-full-face": "price_1SziCULVWAMw3iFeKQ7lsdNk",
};

// ==============================
// RESOLVE PRICE ID
// ==============================
function resolvePriceId(item) {
  try {
    if (item.type === "morpheus") {
      return priceMap.morpheus?.[item.serviceKey]?.[item.packageKey]?.[item.addon || "none"];
    }
    if (item.type === "membership") return priceMap.membership?.[item.plan]?.[item.package];
    if (item.type === "laser") return priceMap.laser?.[item.area]?.[item.package];
    if (item.type === "full-body") return priceMap["full-body"]?.[item.package]?.[item.addon || "none"];
    if (item.type === "facial") return priceMap[item.service]?.[item.key];
    if (item.type === "med-spa") return priceMap["med-spa"]?.[item.service]?.[item.package]?.[item.addon || "none"];
    if (item.type === "other-service") return otherServicesPrices?.[item.serviceKey];
    return null;
  } catch {
    return null;
  }
}

// ==============================
// RESOLVE DISCOUNTS (FINAL)
// ==============================
async function resolveDiscounts(customer, items) {
  const resolvedItems = items
  .filter(item => item.type !== "morpheus")
  .map(item => {
    const priceId = resolvePriceId(item);
    if (!priceId) throw new Error("Produto inválido");
    return { priceId, quantity: item.quantity || 1 };
  });
  const laserIds = [
    ...Object.values(priceMap.laser).flatMap(a => Object.values(a)),
    ...Object.values(priceMap["full-body"]).flatMap(p => Object.values(p))
  ];

  const facialIds = [
    ...Object.values(priceMap["ll-signature"]),
    ...Object.values(priceMap["classic-deluxe"]),
    ...Object.values(priceMap["ll-teen"])
  ];

  const microneedlingSingleId = priceMap["med-spa"].microneedling.single.none;
  const membershipPlatinumId = priceMap.membership.platinum["6"];
  const otherFullFaceId = otherServicesPrices["combo-full-face"];

  let hasLaser = false;
  let hasFacial = false;
  let hasMicroneedling = false;
  let hasMembershipPlatinum = false;
  let hasOtherFullFace = false;

  let currentFacialPurchase = 0;

  for (const item of resolvedItems) {
    if (laserIds.includes(item.priceId)) hasLaser = true;
    if (facialIds.includes(item.priceId)) hasFacial = true;
    if (item.priceId === microneedlingSingleId) hasMicroneedling = true;
    if (item.priceId === membershipPlatinumId) hasMembershipPlatinum = true;
    if (item.priceId === otherFullFaceId) hasOtherFullFace = true;
  }

  // ==============================
// 1️⃣ POPUP FIRST PURCHASE (PRIORIDADE)
// ==============================
if (customer.popup_unlocked && !customer.first_purchase_used) {
  return {
    discounts: [{ coupon: "jmx11QWL" }],
    metadata: { discount_type: "first_purchase" }
  };
}

// ==============================
// 2️⃣ MICRONEEDLING
// ==============================
if (hasMicroneedling && !customer.microneedling_discount_used) {
  return {
    discounts: [{ coupon: "U2VFw8Yj" }],
    metadata: { discount_type: "microneedling" }
  };
}

// ==============================
// 3️⃣ MEMBERSHIP
// ==============================
if (hasMembershipPlatinum) {
  return {
    discounts: [{ coupon: "thCriSEx" }],
    metadata: { discount_type: "membership" }
  };
}

// ==============================
// 4️⃣ OTHER SERVICES
// ==============================
if (hasOtherFullFace) {
  return {
    discounts: [{ coupon: "oLmALLlo" }],
    metadata: { discount_type: "other" }
  };
}

  // ==============================
  // 5️⃣ FACIAL (APENAS COMPRA ATUAL)
  // ==============================
  if (hasFacial) {
    for (const item of resolvedItems) {
      if (facialIds.includes(item.priceId)) {
        const stripePrice = await stripe.prices.retrieve(item.priceId);
        currentFacialPurchase += (stripePrice.unit_amount / 100) * item.quantity;
      }
    }

    let discountTier = 0;
    if (currentFacialPurchase >= 1500) discountTier = 10;
    else if (currentFacialPurchase >= 600) discountTier = 7;
    else if (currentFacialPurchase >= 300) discountTier = 5;

    if (discountTier > 0) {
      const couponMap = { 10: "BNKguNqk", 7: "qQVDq1Hd", 5: "pvJpxT7h" };
      return {
        discounts: [{ coupon: couponMap[discountTier] }],
        metadata: { discount_type: "facial" }
      };
    }
  }

  // ==============================
  // 6️⃣ CASHBACK
  // ==============================
  if (customer.cashback_balance > 0) {
    const coupon = await stripe.coupons.create({
      amount_off: Math.round(customer.cashback_balance * 100),
      currency: "usd",
      duration: "once",
      name: "Universal Cashback"
    });
    return {
      discounts: [{ coupon: coupon.id }],
      metadata: { discount_type: "cashback" }
    };
  }

  return { discounts: [], metadata: {} };
}

// ==============================
// WEBHOOK (PRECISA VIR ANTES DO express.json())
// ==============================
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Erro webhook:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = await stripe.checkout.sessions.retrieve(
        event.data.object.id,
        { expand: ["line_items.data.price.product"] }
      );

      const email = session.customer_details?.email;
      if (!email) return res.json({ received: true });

      const customer = await getOrCreateCustomer(email);

      // Evita processar a mesma sessão duas vezes
      if (customer?.last_checkout_session === session.id) {
        return res.json({ received: true });
      }

      const LASER_SERVICES_CASHBACK = [
        "Jawline","Areolas","Happy Trails","Men Bears","Feet","Sideburns","Ears","Chin","Upper Lip",
        "Back-Neck", "Front-Neck","Shoulders","Under Arms","Bikini Line",
        "Upper Legs","Lower Legs","Lower Back","Half Back","Upper Arms","Lower Arms","Chest","Abdomen","Buttocks","Full Face","Full Brazillian",
        "Full Chest","Full Arms","Full Legs","Full Back"
      ];

      let totalLaser = 0;
      let totalFacial = 0;
      let totalLifetime = 0;
      let microneedlingUsed = false;

      let cashbackEligible = false;

      for (const item of session.line_items.data) {
        const product = item.price.product;
        const quantity = item.quantity || 1;
        const amount = (item.price.unit_amount / 100) * quantity;
        totalLifetime += amount;

        const { mode, service_name } = product.metadata || {};

        // Determina se é elegível para cashback
        if (mode === "laser" && LASER_SERVICES_CASHBACK.includes(service_name)) {
          totalLaser += amount;
          cashbackEligible = true;
        }

        if (mode === "facial") totalFacial += amount;
        if (mode === "med-spa" && product.metadata?.addon === "none") microneedlingUsed = true;
      }

      // Aplicar cashback automático via cupom
      if (cashbackEligible && customer.cashback_balance > 0) {
        const coupon = await stripe.coupons.create({
          amount_off: Math.round(customer.cashback_balance * 100),
          currency: "usd",
          duration: "once",
          name: "Automatic Cashback"
        });

        // Aplica o cupom diretamente ao checkout
        await stripe.checkout.sessions.update(session.id, {
          discounts: [{ coupon: coupon.id }]
        });

        console.log(`Cashback aplicado para ${email}: $${customer.cashback_balance}`);
      }

      await supabase
        .from("customers")
        .update({ last_checkout_session: session.id })
        .eq("email", email);

      console.log(`Pagamento processado: ${email}`);
      console.log(`Total Laser: ${totalLaser}, Total Facial: ${totalFacial}, Total Lifetime: ${totalLifetime}, Microneedling: ${microneedlingUsed}`);
    }

    res.json({ received: true });
  }
);

// ==============================
// SERVICE LABELS (EXATOS DO SITE)
// ==============================

const morpheusAreas = {
  "face-neck-chest": "Face, Neck & Chest",
  "face-neck": "Face & Neck",
  "face": "Full Face",
  "neck": "Neck",
  "chest": "Chest",
  "eyes": "Eyes",
  "mouth": "Mouth",
  "acne-scars": "Acne Scars",
  "active-acne": "Active Acne",
  "scars": "Scars",
  "spot-treatment": "Spot Treatment",
  "hands": "Hands"
};

const morpheusBodyAreas = {
  "back-acne": "Back Acne",
  "stretchmark-one-area": "Stretchmark (One Area)",
  "upper-arms": "Upper Arms",
  "knees": "Knees",
  "abdomen": "Abdomen",
  "inner-thighs": "Inner Thighs",
  "outer-thighs": "Outer Thighs",
  "thighs": "Thighs",
  "cellulite": "Cellulite",
  "excess-sweating": "Excess Sweating"
};

const lumeccaAreas = {
  "face-neck-chest": "Face, Neck & Chest",
  "face-neck": "Face & Neck",
  "face": "Full Face",
  "neck": "Neck",
  "chest": "Chest",
  "eyes": "Eyes",
  "mouth": "Mouth",
  "acne-scars": "Acne Scars",
  "active-acne": "Active Acne",
  "scars": "Scars",
  "spot-treatment": "Spot Treatment",
  "hands": "Hands"
};

const packageLabels = {
  "single": "Single Session",
  "2": "3 Sessions",
  "3": "3 Sessions"
};

const addonLabels = {
  "none": "No Additional",
  "led10": "Led (10 min)",
  "led20": "Led (20 min)",
  "exosomes": "Exosomes",
  "salmon": "Salmon DNA PDRN",
  "led10-exosomes": "Led (10 min) + Exosomes",
  "led20-exosomes": "Led (20 min) + Exosomes",
  "led10-salmon": "Led (10 min) + Salmon DNA PDRN",
  "led20-salmon": "Led (20 min) + Salmon DNA PDRN"
};

// ==============================
// MORPHEUS / BODY / LUMECCA BASE PRICES (SERVER OFFICIAL)
// ==============================

const MORPHEUS_BASE_PRICES = {

  morpheus: {
    face: 833,
    neck: 833,
    chest: 833,
    "face-neck": 1000,
    "face-neck-chest": 1050,
    eyes: 650,
    mouth: 650,
    "acne-scars": 800,
    "active-acne": 750,
    scars: 650,
    "spot-treatment": 350,
    hands: 450
  },

  body: {
    "back-acne": 1400,
    "stretchmark-one-area": 900,
    "upper-arms": 1000,
    knees: 1000,
    abdomen: 1500,
    "inner-thighs": 1250,
    "outer-thighs": 1250,
    thighs: 1499,
    cellulite: 1499,
    "excess-sweating": 900
  },

  lumecca: {
    face: 500,
    neck: 350,
    chest: 500,
    "face-neck": 800,
    "face-neck-chest": 950,
    eyes: 550,
    mouth: 550,
    "acne-scars": 700,
    "active-acne": 650,
    scars: 550,
    "spot-treatment": 250,
    hands: 350
  }

};

// ==============================
// PACKAGE DISCOUNTS
// ==============================

const MORPHEUS_PACKAGE_DISCOUNT = {
  single: 0,
  "2": 0.05,
  "3": 0.10
};

// ==============================
// ADDONS
// ==============================

const MORPHEUS_ADDON_PRICES = {
  none: 0,
  led10: 30,
  led20: 50,
  exosomes: 100,
  salmon: 100,
  "led10-exosomes": 130,
  "led20-exosomes": 150,
  "led10-salmon": 130,
  "led20-salmon": 150
};

const MORPHEUS_COMBO_DISCOUNT = 0.10;

// ==============================
// CALCULATE MORPHEUS PRICE (SERVER SIDE)
// ==============================

function getMorpheusPrice(item) {

  const { mode, area, packageKey, addon, combo } = item;

  // 1️⃣ VALIDAR MODE
  if (!MORPHEUS_BASE_PRICES[mode]) {
    throw new Error("Modo inválido");
  }

  // 2️⃣ VALIDAR ÁREA
  const basePriceSingle = MORPHEUS_BASE_PRICES[mode][area];
  if (!basePriceSingle) {
    throw new Error("Área inválida");
  }

  // 3️⃣ VALIDAR PACKAGE
  const sessions = packageKey === "single" ? 1 : parseInt(packageKey);
  if (!sessions || sessions < 1) {
    throw new Error("Pacote inválido");
  }

  let baseServicePrice;

  // 4️⃣ COMBO (morpheus + lumecca)
  if (combo) {

    const morpheusPrice = MORPHEUS_BASE_PRICES.morpheus[area];
    const lumeccaPrice = MORPHEUS_BASE_PRICES.lumecca[area];

    if (!morpheusPrice || !lumeccaPrice) {
      throw new Error("Combo inválido");
    }

    baseServicePrice =
      (morpheusPrice + lumeccaPrice) *
      (1 - MORPHEUS_COMBO_DISCOUNT);

  } else {

    baseServicePrice = basePriceSingle;

  }

  // 5️⃣ MULTIPLICA POR SESSÕES
  let totalService = baseServicePrice * sessions;

  // 6️⃣ APLICA DESCONTO DO PACOTE
  const packageDiscount = MORPHEUS_PACKAGE_DISCOUNT[packageKey] || 0;
  totalService = totalService * (1 - packageDiscount);

  // 7️⃣ ADDON (multiplica por sessões, sem desconto)
  const addonBase = MORPHEUS_ADDON_PRICES[addon || "none"];
  if (addonBase === undefined) {
    throw new Error("Addon inválido");
  }

  const totalAddon = addonBase * sessions;

  // 8️⃣ VALOR FINAL
  const finalPrice = Math.round(totalService + totalAddon);

  if (finalPrice <= 0) {
    throw new Error("Erro no cálculo");
  }

  return finalPrice;
}
// ==============================
// CREATE CHECKOUT SESSION (UPDATED)
// ==============================
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { email, items } = req.body;

     // ==============================
    // EMAIL VALIDATION
    // ==============================
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email" });
    }

    // ==============================
    // VALIDATION LAYER
    // ==============================

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email" });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Invalid cart items" });
    }

    if (items.length > MAX_CART_ITEMS) {
      return res.status(400).json({ error: "Too many items in cart" });
    }

    for (const item of items) {
  if (!VALID_TYPES.includes(item.type)) {
    return res.status(400).json({ error: "Invalid product type" });
  }

  const quantity = Number(item.quantity) || 1;

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ITEM_QUANTITY) {
    return res.status(400).json({ error: "Invalid quantity" });
  }
}

    const customer = await getOrCreateCustomer(email);

// ==============================
// BUILD LINE ITEMS
// ==============================
const line_items = items.map((item, index) => {

  // 🔥 MORPHEUS DINÂMICO
  if (item.type === "morpheus") {

  const calculatedPrice = getMorpheusPrice(item);

  let areaName = morpheusAreas[item.area] || "Treatment";
  const packageName = packageLabels[item.packageKey] || "";
  const addonName = addonLabels[item.addon] || "";

  const parts = [areaName, packageName];

  if (addonName) {
    parts.push(addonName);
  } else {
    parts.push("No Additional");
  }

  if (item.combo) {
    parts.push("Combo");
  }

  const fullName = parts.filter(Boolean).join(" - ");

  return {
    price_data: {
      currency: "usd",
      product_data: {
        name: fullName,
        images: [
          "https://cdn.prod.website-files.com/65de549be003197a7c137f6b/699f468b700aaf1a46a3263e_WhatsApp%20Image%202026-02-25%20at%2015.58.50.jpeg"
        ],
        metadata: {
          service_name: areaName,
          package: item.packageKey,
          addon: item.addon || "none",
          combo: item.combo ? "yes" : "no",
          mode: item.mode
        }
      },
      unit_amount: calculatedPrice * 100,
    },
    quantity: item.quantity || 1,
  };
}

      // 🔥 OUTROS PRODUTOS (mantém Stripe priceId)
      const priceId = resolvePriceId(item);
      if (!priceId) throw new Error("Produto inválido");

      return {
        price: priceId,
        quantity: item.quantity || 1,
      };
    });

    // ==============================
    // DISCOUNTS
    // ==============================
    const { discounts, metadata } = await resolveDiscounts(customer, items);

    const hasAutoDiscount = discounts && discounts.length > 0;
    
    const onlyMorpheus = items.every(item => item.type === "morpheus");

    // ==============================
    // CREATE SESSION
    // ==============================
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      line_items,

      ...(hasAutoDiscount
  ? { discounts }
  : onlyMorpheus
    ? { allow_promotion_codes: true }
    : {}),

      metadata: {
        customer_email: email,
        cart_items_count: items.length,
        ...metadata
      },

      success_url:
        "https://lltouch.com/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://lltouch.com/cancel",
    });

    res.json({ url: session.url });

  } catch (error) {
    console.error("Erro checkout:", error);
    res.status(500).json({ error: "Erro ao criar sessão" });
  }
});

// ==============================
// UNLOCK POPUP
// ==============================
app.post("/unlock-popup", async (req, res) => {
  const { email } = req.body;

  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Email inválido" });
  }

  try {
    await getOrCreateCustomer(email);

    await supabase
      .from("customers")
      .update({ popup_unlocked: true })
      .eq("email", email);

    res.json({ success: true });
  } catch (err) {
    console.error("Erro unlock-popup:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// ==============================
// ROOT
// ==============================
app.get("/", (_, res) =>
  res.send("Stripe API running 🚀")
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("Server running on port", PORT)
);