import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import rateLimit from "express-rate-limit";

dotenv.config();

// ==============================
// SECURITY & CONSTANTS CONFIG
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
app.set('trust proxy', 1); 
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ==============================
// SUPABASE
// ==============================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ==============================
// CUSTOMER HELPERS
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
        popup_unlocked: false
      }])
      .select()
      .single();

    customer = data;
  }

  return customer;
}

// ==============================
// MIDDLEWARES
// ==============================
app.use(cors({
  origin: [
    "https://lltouch.com",
    "https://www.lltouch.com"
  ]
}));

// ==============================
// WEBHOOK CORRIGIDO
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

    // Processa apenas pagamentos completos
    if (event.type === "checkout.session.completed") {
      try {

        const session = await stripe.checkout.sessions.retrieve(
          event.data.object.id,
          { expand: ["line_items.data.price.product"] }
        );

        const email = session.customer_details?.email;
        if (!email) return res.json({ received: true });

        const customer = await getOrCreateCustomer(email);

        // Evita duplicação do webhook
        if (customer?.last_checkout_session === session.id) {
          console.log("Webhook duplicado ignorado:", session.id);
          return res.json({ received: true });
        }

// ==========================
// 1️⃣ CALCULA TOTAIS
// ==========================

let totalLaser = 0;
let totalLifetime = 0;

for (const item of session.line_items.data) {
  const product = item.price.product;
  const metadata = product.metadata || {};
  const quantity = item.quantity || 1;

  const amount = item.amount_total / 100;
  
  totalLifetime += amount;

  console.log("Produto:", product.name);
  console.log("Metadata:", metadata);
  console.log("Valor:", amount.toFixed(2));

  if (metadata.mode === "laser" || metadata.mode === "full-body") {
    totalLaser += amount;
  }
}

console.log("Total Lifetime:", totalLifetime.toFixed(2));
console.log("Total Laser:", totalLaser.toFixed(2));

// ==========================
// 2️⃣ CALCULA CASHBACK
// ==========================

let rate = 0;

if (totalLaser >= 3000) rate = 0.10;
else if (totalLaser >= 1500) rate = 0.07;
else if (totalLaser >= 500) rate = 0.05;

const cashbackEarned = Number((totalLaser * rate).toFixed(2));

console.log("Cashback Rate:", rate);
console.log("Cashback Earned:", cashbackEarned);

// ==========================
// 3️⃣ CALCULA CASHBACK USADO E GANHO
// ==========================

// Valor de cashback usado nesta compra (se houver)
const usedCashback = Number(session.metadata?.cashback_used_amount || 0);
console.log("Cashback Usado:", usedCashback);

// Valor efetivamente pago pelo cliente (após desconto de cashback)
const effectivePayment = totalLaser - usedCashback;
console.log("Valor efetivo pago:", effectivePayment.toFixed(2));

// Determina a taxa de cashback com base no gasto efetivo
rate = 0;
if (effectivePayment >= 3000) rate = 0.10;
else if (effectivePayment >= 1500) rate = 0.07;
else if (effectivePayment >= 500) rate = 0.05;

const cashbackEarnedAfterUsed = Number((effectivePayment * rate).toFixed(2));
console.log("Cashback Ganho:", cashbackEarnedAfterUsed);

// ==========================
// 4️⃣ ATUALIZA SUPABASE
// ==========================

const { error: updateError } = await supabase
  .from("customers")
  .upsert(
    {
      email: email,
      lifetime_total: customer.lifetime_total + totalLaser, // ou totalLifetime se quiser somar todos os serviços
      laser_total: customer.laser_total + totalLaser,
      cashback_balance: customer.cashback_balance - usedCashback + cashbackEarnedAfterUsed,
      laser_tier: rate,
      last_checkout_session: session.id,
      updated_at: new Date()
    },
    { onConflict: "email" }
  );

if (updateError) {
  console.error("Erro atualizando cliente:", updateError);
}

// ==========================
// 5️⃣ REGISTRA TRANSAÇÕES DE CASHBACK
// ==========================

// Registro do cashback ganho
if (cashbackEarnedAfterUsed > 0) {
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + 6);

  const { error } = await supabase
    .from("cashback_transactions")
    .insert({
      email: email,
      amount: cashbackEarnedAfterUsed,
      type: "earned",
      category: "laser",
      source: "stripe",
      payment_intent: session.payment_intent,
      expires_at: expiresAt
    });

  if (error) console.error("Erro inserindo cashback ganho:", error);
}

// Registro do cashback usado
if (usedCashback > 0) {
  const { error } = await supabase
    .from("cashback_transactions")
    .insert({
      email: email,
      amount: usedCashback,
      type: "used",
      category: "laser",
      source: "stripe",
      payment_intent: session.payment_intent
    });

  if (error) console.error("Erro inserindo cashback usado:", error);
}

console.log(
  `Pagamento processado: ${email} | Pagou: $${effectivePayment.toFixed(
    2
  )} | Cashback Ganho: $${cashbackEarnedAfterUsed.toFixed(
    2
  )} | Cashback Usado: $${usedCashback.toFixed(2)}`
);

      } catch (err) {
        console.error("Erro processando pagamento:", err);
      }
    }

    res.json({ received: true });
  }
);

app.use(express.json());

const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: "Too many requests. Try again later." }
});

// ==============================
// PRICE TABLES & LABELS
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

const morpheusAreas = {

  // FACE
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
  "hands": "Hands",

  // BODY
  "upper-arms": "Upper Arms",
  "abdomen": "Abdomen",
  "back-acne": "Back Acne",
  "thighs": "Thighs",
  "inner-thighs": "Inner Thighs",
  "outer-thighs": "Outer Thighs",
  "knees": "Knees",
  "cellulite": "Cellulite",
  "stretchmark-one-area": "Stretchmark (One Area)",
  "excess-sweating": "Excess Sweating"

};

const packageLabels = { "single": "Single Session", "2": "3 Sessions", "3": "3 Sessions" };

const addonLabels = {
  "none": "No Additional", "led10": "Led (10 min)", "led20": "Led (20 min)",
  "exosomes": "Exosomes", "salmon": "Salmon DNA PDRN",
  "led10-exosomes": "Led (10 min) + Exosomes", "led20-exosomes": "Led (20 min) + Exosomes",
  "led10-salmon": "Led (10 min) + Salmon DNA PDRN", "led20-salmon": "Led (20 min) + Salmon DNA PDRN"
};

const MORPHEUS_BASE_PRICES = {
  morpheus: { face: 833, neck: 833, chest: 833, "face-neck": 1000, "face-neck-chest": 1050, eyes: 650, mouth: 650, "acne-scars": 800, "active-acne": 750, scars: 650, "spot-treatment": 350, hands: 450 },
  body: { "back-acne": 1400, "stretchmark-one-area": 900, "upper-arms": 1000, knees: 1000, abdomen: 1500, "inner-thighs": 1250, "outer-thighs": 1250, thighs: 1499, cellulite: 1499, "excess-sweating": 900 },
  lumecca: { face: 500, neck: 350, chest: 500, "face-neck": 800, "face-neck-chest": 950, eyes: 550, mouth: 550, "acne-scars": 700, "active-acne": 650, scars: 550, "spot-treatment": 250, hands: 350 }
};

const MORPHEUS_PACKAGE_DISCOUNT = { single: 0, "2": 0.05, "3": 0.10 };
const MORPHEUS_ADDON_PRICES = { none: 0, led10: 30, led20: 50, exosomes: 100, salmon: 100, "led10-exosomes": 130, "led20-exosomes": 150, "led10-salmon": 130, "led20-salmon": 150 };
const MORPHEUS_COMBO_DISCOUNT = 0.10;
const MORPHEUS_CONSULTATION_FEE = 100;


// ==============================
// LOGIC CALCULATORS
// ==============================

function resolvePriceId(item) {
  try {
    if (item.type === "morpheus") return null; // Morpheus é calculado dinamicamente
    if (item.type === "membership") return priceMap.membership?.[item.plan]?.[item.package];
    if (item.type === "laser") return priceMap.laser?.[item.area]?.[item.package];
    if (item.type === "full-body") return priceMap["full-body"]?.[item.package]?.[item.addon || "none"];
    if (item.type === "facial") return priceMap[item.service]?.[item.key];
    if (item.type === "med-spa") return priceMap["med-spa"]?.[item.service]?.[item.package]?.[item.addon || "none"];
    if (item.type === "other-service") return otherServicesPrices?.[item.serviceKey];
    return null;
  } catch { return null; }
}

function getMorpheusPrice(item) {
  const { mode, area, packageKey, addon, combo } = item;
  if (!MORPHEUS_BASE_PRICES[mode]) throw new Error("Modo inválido");
  const basePriceSingle = MORPHEUS_BASE_PRICES[mode][area];
  if (!basePriceSingle) throw new Error("Área inválida");
  const sessions = packageKey === "single" ? 1 : parseInt(packageKey);
  if (!sessions || sessions < 1) throw new Error("Pacote inválido");

  let baseServicePrice;
  if (combo) {
    const morpheusPrice = MORPHEUS_BASE_PRICES.morpheus[area];
    const lumeccaPrice = MORPHEUS_BASE_PRICES.lumecca[area];
    if (!morpheusPrice || !lumeccaPrice) throw new Error("Combo inválido");
    baseServicePrice = (morpheusPrice + lumeccaPrice) * (1 - MORPHEUS_COMBO_DISCOUNT);
  } else {
    baseServicePrice = basePriceSingle;
  }

  let totalService = baseServicePrice * sessions;
  const packageDiscount = MORPHEUS_PACKAGE_DISCOUNT[packageKey] || 0;
  totalService = totalService * (1 - packageDiscount);

  const addonBase = MORPHEUS_ADDON_PRICES[addon || "none"];
  if (addonBase === undefined) throw new Error("Addon inválido");
  const totalAddon = addonBase * sessions;

  const finalPrice = Math.round(totalService + totalAddon);
  if (finalPrice <= 0) throw new Error("Erro no cálculo");
  return finalPrice;
}

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

  let hasLaser = false, hasFacial = false, hasMicroneedling = false, hasMembershipPlatinum = false, hasOtherFullFace = false;
  let currentFacialPurchase = 0;

  for (const item of resolvedItems) {
    if (laserIds.includes(item.priceId)) hasLaser = true;
    if (facialIds.includes(item.priceId)) hasFacial = true;
    if (item.priceId === microneedlingSingleId) hasMicroneedling = true;
    if (item.priceId === membershipPlatinumId) hasMembershipPlatinum = true;
    if (item.priceId === otherFullFaceId) hasOtherFullFace = true;
  }

  // =======================
  // Descontos especiais
  // =======================
  if (customer.popup_unlocked && !customer.first_purchase_used) {
    return { discounts: [{ coupon: "jmx11QWL" }], metadata: { discount_type: "first_purchase" } };
  }
  if (hasMicroneedling && !customer.microneedling_discount_used) {
    return { discounts: [{ coupon: "U2VFw8Yj" }], metadata: { discount_type: "microneedling" } };
  }
  if (hasMembershipPlatinum) {
    return { discounts: [{ coupon: "thCriSEx" }], metadata: { discount_type: "membership" } };
  }
  if (hasOtherFullFace) {
    return { discounts: [{ coupon: "oLmALLlo" }], metadata: { discount_type: "other" } };
  }

  // =======================
  // Descontos faciais
  // =======================
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
      const couponMap = { 10: "xu5jbAdc", 7: "vwkWvHPm", 5: "nzcBZv4q" };
      return { discounts: [{ coupon: couponMap[discountTier] }], metadata: { discount_type: "facial" } };
    }
  }

  // =======================
  // Cashback
  // =======================
  if (customer.cashback_balance > 0) {

  let currentCartTotal = 0;

  for (const item of items) {

    if (item.type === "morpheus") {
      const price = getMorpheusPrice(item);
      currentCartTotal += price * (item.quantity || 1);
      continue;
    }

    const priceId = resolvePriceId(item);
    const stripePrice = await stripe.prices.retrieve(priceId);

    currentCartTotal += (stripePrice.unit_amount / 100) * (item.quantity || 1);
  }

  const maxAllowedDiscount = currentCartTotal * 0.5;

  const finalCashbackAmount = Math.min(
    customer.cashback_balance,
    maxAllowedDiscount
  );

  if (finalCashbackAmount > 0) {

    const coupon = await stripe.coupons.create({
      amount_off: Math.round(finalCashbackAmount * 100),
      currency: "usd",
      duration: "once",
      name: `Cashback Used (Max 50%)`
    });

    return {
      discounts: [{ coupon: coupon.id }],
      metadata: {
        discount_type: "cashback_used",
        cashback_used_amount: finalCashbackAmount
      }
    };

  }
}
    return { discounts: [], metadata: {} };

}
app.post("/cashback-preview", (req, res) => {
  try {
    const { cart } = req.body;
    if (!cart || !Array.isArray(cart)) return res.json({ cashback: 0, rate: 0, tier: "Bronze" });

    // Filtra apenas itens das páginas de Laser para o cálculo de acúmulo
    const laserSubtotal = cart.reduce((acc, item) => {
      if (item.mode === 'laser' || item.mode === 'full-body') {
        const qty = item.quantity || 1;
        return acc + (item.price * qty);
      }
      return acc;
    }, 0);

    // Define a porcentagem baseada no gasto da COMPRA ATUAL (Preview)
    let rate = 0;
    let tier = "Bronze";

    if (laserSubtotal >= 3000) { rate = 0.10; tier = "Gold"; }
    else if (laserSubtotal >= 1500) { rate = 0.07; tier = "Silver"; }
    else if (laserSubtotal >= 500) { rate = 0.05; tier = "Bronze"; }

    res.json({ 
      cashback: Number((laserSubtotal * rate).toFixed(2)), 
      rate: rate,
      tier: tier,
      laserSubtotal: laserSubtotal
    });
  } catch (err) {
    res.status(500).json({ error: "Erro no cálculo de preview" });
  }
  });

  app.get("/customer", async (req, res) => {
  try {

    const email = req.query.email;

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Email inválido" });
    }

    const { data: customer, error } = await supabase
      .from("customers")
      .select("email, cashback_balance, laser_total, lifetime_total, laser_tier")
      .eq("email", email)
      .maybeSingle();

    if (error) {
      console.error(error);
      return res.status(500).json({ error: "Erro ao buscar cliente" });
    }

    if (!customer) {
      return res.json({
        email,
        cashback_balance: 0,
        laser_total: 0,
        lifetime_total: 0,
        laser_tier: "bronze"
      });
    }

    res.json(customer);

  } catch (err) {
    console.error("Erro /customer:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

app.get("/checkout-session/:id", async (req, res) => {
  try {

    const session = await stripe.checkout.sessions.retrieve(
      req.params.id,
      { expand: ["line_items.data.price.product"] }
    );

    const items = session.line_items.data.map(item => ({
      name: item.price.product.name,
      amount: (item.price.unit_amount / 100) * item.quantity
    }));

    res.json({
      id: session.id,
      email: session.customer_details?.email,
      total: session.amount_total / 100,
      items
    });

  } catch (err) {
    console.error("Erro buscando sessão:", err);
    res.status(500).json({ error: "Erro ao buscar sessão" });
  }
});
// ==============================
// ROUTES
// ==============================

app.post("/create-checkout-session", checkoutLimiter, async (req, res) => {
  try {
    const { email, items } = req.body;

    if (!isValidEmail(email)) return res.status(400).json({ error: "Invalid email" });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Invalid cart items" });
    if (items.length > MAX_CART_ITEMS) return res.status(400).json({ error: "Too many items in cart" });

    for (const item of items) {
      if (!VALID_TYPES.includes(item.type)) return res.status(400).json({ error: "Invalid product type" });
      const quantity = Number(item.quantity) || 1;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ITEM_QUANTITY) {
        return res.status(400).json({ error: "Invalid quantity" });
      }
    }

    const customer = await getOrCreateCustomer(email);

    const line_items = items.map((item) => {
      if (item.type === "morpheus") {

  const consultationFee = 100;

  const areas = item.selectedAreas || [];

  const areasText = areas.join("\n");

  const displayName = "Morpheus8 Consultation";

  return {
    price_data: {
      currency: "usd",

      product_data: {

        name: displayName,

        description: `${areasText}

$100 Reservation Fee – Applied toward treatment`,

        images: [
          "https://cdn.prod.website-files.com/65de549be003197a7c137f6b/699f468b700aaf1a46a3263e_WhatsApp%20Image%202026-02-25%20at%2015.58.50.jpeg"
        ],

        metadata: {
          areas: areas.join(", ")
        }

      },

      unit_amount: consultationFee * 100
    },

    quantity: 1
  };
}

      const priceId = resolvePriceId(item);
      if (!priceId) throw new Error("Produto inválido");
      return { price: priceId, quantity: item.quantity || 1 };
    });

    const { discounts, metadata } = await resolveDiscounts(customer, items);
    const hasAutoDiscount = discounts && discounts.length > 0;
    const onlyMorpheus = items.every(item => item.type === "morpheus");

    const cashbackUsedAmount = metadata?.cashback_used_amount || 0;

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
  cashback_used_amount: cashbackUsedAmount,
  ...metadata
},

      success_url: "https://lltouch.com/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://lltouch.com/cancel",
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("Erro checkout:", error);
    res.status(500).json({ error: "Erro ao criar sessão" });
  }
});

app.post("/unlock-popup", async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Email inválido" });
  try {
    await getOrCreateCustomer(email);
    await supabase.from("customers").update({ popup_unlocked: true }).eq("email", email);
    res.json({ success: true });
  } catch (err) {
    console.error("Erro unlock-popup:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

app.get("/", (_, res) => res.send("Stripe API running 🚀"));

// ==============================
// SERVER START
// ==============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));