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
  "morpheus"
];

const MAX_CART_ITEMS = 20;
const MAX_ITEM_QUANTITY = 10;

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function cleanLeadField(value, max = 300) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeJsonParse(value, fallback = null) {
  try {
    if (!value) return fallback;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/\+/g, "plus")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function formatDateOnly(value) {
  const str = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  return str;
}

const app = express();
app.set("trust proxy", 1);

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
    "https://www.lltouch.com",
    "https://llbrows.com",
    "https://www.llbrows.com",
    "https://ludimillas.webflow.io"
  ]
}));

// ==============================
// STRIPE WEBHOOK
// Keep this route before express.json()
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
      try {
        const session = await stripe.checkout.sessions.retrieve(
          event.data.object.id,
          { expand: ["line_items.data.price.product"] }
        );

        const checkoutBrand = String(session.metadata?.brand || "").toLowerCase();

        // LL Brows payments share the same Stripe account/webhook, but they must
        // not enter LL Touch cashback, laser totals or first-purchase logic.
        if (checkoutBrand === "ll_brows") {
          console.log(
            `LL Brows payment confirmed: ${session.id} | ${session.customer_details?.email || "no email"}`
          );
          return res.json({ received: true });
        }

        const email = session.customer_details?.email;
        if (!email) return res.json({ received: true });

        const customer = await getOrCreateCustomer(email);

        if (customer?.last_checkout_session === session.id) {
          console.log("Webhook duplicado ignorado:", session.id);
          return res.json({ received: true });
        }

        let totalLaser = 0;
        let totalLifetime = 0;

        for (const item of session.line_items.data) {
          const product = item.price.product;
          const metadata = product.metadata || {};
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

        const usedCashback = Number(session.metadata?.cashback_used_amount || 0);
        console.log("Cashback Usado:", usedCashback);

        const effectivePayment = totalLaser - usedCashback;
        console.log("Valor efetivo pago:", effectivePayment.toFixed(2));

        let rate = 0;
        if (effectivePayment >= 3000) rate = 0.10;
        else if (effectivePayment >= 1500) rate = 0.07;
        else if (effectivePayment >= 500) rate = 0.05;

        const cashbackEarnedAfterUsed = Number((effectivePayment * rate).toFixed(2));
        console.log("Cashback Ganho:", cashbackEarnedAfterUsed);

        const { error: updateError } = await supabase
          .from("customers")
          .upsert(
            {
              email,
              lifetime_total: Number(customer.lifetime_total || 0) + totalLaser,
              laser_total: Number(customer.laser_total || 0) + totalLaser,
              cashback_balance:
                Number(customer.cashback_balance || 0) -
                usedCashback +
                cashbackEarnedAfterUsed,
              laser_tier: rate,
              last_checkout_session: session.id,
              updated_at: new Date()
            },
            { onConflict: "email" }
          );

        if (updateError) {
          console.error("Erro atualizando cliente:", updateError);
        }

        if (cashbackEarnedAfterUsed > 0) {
          const expiresAt = new Date();
          expiresAt.setMonth(expiresAt.getMonth() + 6);

          const { error } = await supabase
            .from("cashback_transactions")
            .insert({
              email,
              amount: cashbackEarnedAfterUsed,
              type: "earned",
              category: "laser",
              source: "stripe",
              payment_intent: session.payment_intent,
              expires_at: expiresAt
            });

          if (error) console.error("Erro inserindo cashback ganho:", error);
        }

        if (usedCashback > 0) {
          const { error } = await supabase
            .from("cashback_transactions")
            .insert({
              email,
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

app.use(express.json({ limit: "1mb" }));

const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: "Too many requests. Try again later." }
});

// ==============================
// PRICE TABLES & LABELS
// ==============================

const priceMap = {
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

};

// ==============================
// LASER / FULL-BODY — local dollar mirror
// Prices did not change with the new printed price list. The real Stripe
// Price IDs above are still used for the actual checkout line item; this
// table only lets discount/cashback math run locally instead of round
// -tripping to Stripe for every item.
// ==============================
const LASER_DOLLAR_PRICES = {
  small: { single: 85, 6: 450, 8: 600 },
  medium: { single: 120, 6: 630, 8: 840 },
  large: { single: 200, 6: 900, 8: 1200 },
  xlarge: { single: 285, 6: 1200, 8: 2000 }
};

const FULL_BODY_DOLLAR_PRICES = {
  single: { none: 575, fullface: 625 },
  6: { none: 3150, fullface: 3450 },
  8: { none: 4200, fullface: 4600 }
};

// ==============================
// FACIAL TREATMENTS
// Prices computed dynamically (price_data) instead of pre-created Stripe
// Price IDs, so they can be edited here without any Stripe Dashboard work.
// Matches the printed price list. "ll-teen" was removed (no longer offered).
// ==============================
const FACIAL_BASE_PRICES = {
  "ll-signature": { label: "LL Signature Facial", durationMinutes: 75, single: 165, 3: 465 },
  "classic-deluxe": { label: "Classic Deluxe Facial", durationMinutes: 60, single: 150, 3: 420 },
  "diamond-glow": { label: "Diamond Glow", durationMinutes: 60, single: 165, 3: 450 },
  dermaplaning: { label: "Dermaplaning", durationMinutes: 30, single: 150, 3: 350 }
};

// Single-session add-on prices come straight from the printed list. 3-session
// deltas match the bundle pricing already used by LL Signature/Classic Deluxe
// (+69 / +99 / +160), which is uniform across facial types in the existing
// data. "dermaplaning" (during facial) has no printed 3-session bundle price;
// it's assumed to follow the same delta tier as led10 since it shares the
// same single-session price ($30) — flagged as an assumption, not a printed
// figure.
const FACIAL_ADDON_PRICES = {
  none: { single: 0, 3: 0 },
  led10: { single: 30, 3: 69 },
  led20: { single: 50, 3: 99 },
  peel: { single: 65, 3: 160 },
  dermaplaning: { single: 30, 3: 69 }
};

function getFacialPackageKey(item) {
  return item.package === "3" || item.package === 3 ? "3" : "single";
}

function getFacialPrice(item) {
  const service = FACIAL_BASE_PRICES[item.service];
  if (!service) throw new Error("Invalid facial service");

  const pkg = getFacialPackageKey(item);
  const basePrice = service[pkg];
  if (basePrice === undefined) throw new Error("Invalid facial package");

  const addonKey = item.addon || "none";
  const addon = FACIAL_ADDON_PRICES[addonKey];
  if (!addon) throw new Error("Invalid facial add-on");

  return {
    amount: basePrice + addon[pkg],
    name: service.label,
    package: pkg,
    packageLabel: pkg === "3" ? "3 Sessions" : "Single Session",
    addon: addonKey,
    addonLabel: addonLabels[addonKey] || addonKey
  };
}

// ==============================
// MED SPA TREATMENTS
// Same dynamic-pricing approach as Facial. "laser-facial" was renamed to
// "oxi-laser-facial" to match the printed list; "hydrafacial" is new.
// ==============================
const MEDSPA_BASE_PRICES = {
  microneedling: { label: "Microneedling", durationMinutes: 75, single: 200, 3: 450 },
  llumigold: { label: "LLumiGold", durationMinutes: 105, single: 250, 3: 600 },
  "oxi-laser-facial": { label: "Oxi Laser Facial", durationMinutes: 15, single: 180, 3: 450 },
  "glow-up-laser-facial": { label: "Glow Up Laser Facial", durationMinutes: 30, single: 250, 3: 600 },
  hydrafacial: { label: "Hydrafacial", durationMinutes: 60, single: 150, 3: 350 },
  peel: { label: "Peel", durationMinutes: 15, single: 150, 3: 360 }
};

// Add-on prices are per service, single-select (kept consistent with the
// existing combo-key convention rather than introducing independent
// checkboxes). "glow-up-laser-facial" neck/decollete both represent the
// printed "2 areas" option, same price.
const MEDSPA_ADDON_PRICES = {
  microneedling: { none: 0, led10: 10, neck: 50, "led10-neck": 60 },
  llumigold: { none: 0, exosomes: 100, neck: 50, "exosomes-neck": 150 },
  "oxi-laser-facial": { none: 0 },
  "glow-up-laser-facial": { none: 0, neck: 50, decollete: 50 },
  hydrafacial: { none: 0 },
  peel: { none: 0 }
};

// The printed list offers 5 named peel formulas at the same flat price — this
// is a cosmetic "type" selector, not a price variant.
const PEEL_TYPES = {
  glow: "Glow – Brightening",
  renew: "Renew – Surface Renew",
  "firm-lift": "Firm & Lift – Anti-Aging",
  "calm-bright": "Calm & Bright – Sensitive Skin",
  "advanced-corrective": "Advanced / Corrective – Targeted Concerns"
};

function getMedSpaPackageKey(item) {
  return item.package === "3" || item.package === 3 ? "3" : "single";
}

function getMedSpaPrice(item) {
  const service = MEDSPA_BASE_PRICES[item.service];
  if (!service) throw new Error("Invalid med spa service");

  const pkg = getMedSpaPackageKey(item);
  const basePrice = service[pkg];
  if (basePrice === undefined) throw new Error("Invalid med spa package");

  const addonKey = item.addon || "none";
  const addonTable = MEDSPA_ADDON_PRICES[item.service] || {};
  const addonPrice = addonTable[addonKey];
  if (addonPrice === undefined) throw new Error("Invalid med spa add-on");

  let name = service.label;
  if (item.service === "peel" && item.peelType && PEEL_TYPES[item.peelType]) {
    name = `Peel – ${PEEL_TYPES[item.peelType]}`;
  }

  return {
    amount: basePrice + addonPrice,
    name,
    package: pkg,
    packageLabel: pkg === "3" ? "3 Sessions" : "Single Session",
    addon: addonKey,
    addonLabel: addonLabels[addonKey] || addonKey
  };
}

// ==============================
// MEMBERSHIP
// One-time payment covering the full 6-month commitment (monthlyPrice ×
// months), same behavior as the previous Platinum/Gold/Teen plans.
// Replaces Platinum/Gold/Teen entirely with the two plans from the printed
// price list.
// ==============================
const MEMBERSHIP_PLANS = {
  "reset-care": { label: "Reset Care Membership", monthlyPrice: 150, months: 6 },
  "glass-skin": { label: "Glass Skin Membership", monthlyPrice: 250, months: 6 }
};

function getMembershipPrice(item) {
  const plan = MEMBERSHIP_PLANS[item.plan];
  if (!plan) throw new Error("Invalid membership plan");

  return {
    amount: plan.monthlyPrice * plan.months,
    name: plan.label,
    monthlyPrice: plan.monthlyPrice,
    months: plan.months
  };
}

// ==============================
// LL BROWS CHECKOUT CATALOG
// Prices are defined only on the backend. The Webflow page sends serviceKey,
// never a trusted monetary amount.
//
// Optional: set the listed environment variable to a permanent Stripe Price ID.
// When it is absent, Checkout uses the secure unitAmount below via price_data.
// ==============================

const LLB_SERVICES = Object.freeze({
  llb_nanoblading: {
    name: "Nanoblading",
    description: "Realistic hair-stroke permanent brow service",
    unitAmount: 70000,
    priceEnv: "STRIPE_PRICE_LLB_NANOBLADING_700"
  },
  llb_microshading: {
    name: "Microshading",
    description: "Soft shaded permanent brow service",
    unitAmount: 70000,
    priceEnv: "STRIPE_PRICE_LLB_MICROSHADING_700"
  },
  llb_lip_blushing: {
    name: "Lip Blushing",
    description: "Customized soft lip color and definition",
    unitAmount: 65000,
    priceEnv: "STRIPE_PRICE_LLB_LIP_BLUSHING_650"
  },
  llb_top_eyeliner: {
    name: "Top Eyeliner",
    description: "Refined upper-lash definition",
    unitAmount: 45000,
    priceEnv: "STRIPE_PRICE_LLB_TOP_EYELINER"
  },
  llb_brow_waxing: {
    name: "Brow Waxing",
    description: "Precision brow shaping",
    unitAmount: 3000,
    priceEnv: "STRIPE_PRICE_LLB_BROW_WAXING"
  },
  llb_brow_waxing_tinting: {
    name: "Brow Waxing & Tinting",
    description: "Brow shaping with customized tint",
    unitAmount: 6000,
    priceEnv: "STRIPE_PRICE_LLB_BROW_WAXING_TINTING"
  },
  llb_perfecting_touch_up: {
    name: "Perfecting Touch-Up",
    description: "Qualifying touch-up scheduled 3–6 months after the original service",
    unitAmount: 30000,
    priceEnv: "STRIPE_PRICE_LLB_PERFECTING_TOUCH_UP"
  },
  llb_annual_touch_up: {
    name: "Annual Touch-Up",
    description: "Annual maintenance for qualifying returning clients",
    unitAmount: 40000,
    priceEnv: "STRIPE_PRICE_LLB_ANNUAL_TOUCH_UP"
  }
});

function getLLBrowsCheckoutUrl(envName) {
  const value = String(process.env[envName] || "").trim();

  if (!value || !value.startsWith("https://")) {
    throw new Error(`${envName} must be configured with an HTTPS URL.`);
  }

  return value;
}

function createLLBrowsLineItem(serviceKey, service, quantity) {
  const configuredPriceId = String(process.env[service.priceEnv] || "").trim();

  if (configuredPriceId) {
    return {
      price: configuredPriceId,
      quantity
    };
  }

  return {
    quantity,
    price_data: {
      currency: "usd",
      unit_amount: service.unitAmount,
      product_data: {
        name: service.name,
        description: service.description,
        metadata: {
          brand: "ll_brows",
          source: "ll_brows_webflow",
          service_key: serviceKey
        }
      }
    }
  };
}

const packageLabels = {
  single: "Single Session",
  2: "3 Sessions",
  3: "3 Sessions",
  6: "6 Sessions",
  8: "8 Sessions"
};

const addonLabels = {
  none: "No Additional",
  led10: "Led (10 min)",
  led20: "Led (20 min)",
  peel: "Peel",
  dermaplaning: "Dermaplaning (During Facial)",
  exosomes: "Exosomes",
  neck: "Neck",
  decollete: "Décolleté",
  "exosomes-neck": "Exosomes + Neck",
  "led10-neck": "Led (10 min) + Neck",
  salmon: "Salmon DNA PDRN",
  "led10-exosomes": "Led (10 min) + Exosomes",
  "led20-exosomes": "Led (20 min) + Exosomes",
  "led10-salmon": "Led (10 min) + Salmon DNA PDRN",
  "led20-salmon": "Led (20 min) + Salmon DNA PDRN"
};

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

const MORPHEUS_PACKAGE_DISCOUNT = {
  single: 0,
  2: 0.05,
  3: 0.10
};

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
const MORPHEUS_CONSULTATION_FEE = 50;

// ==============================
// VAGARO CONFIG - FASE 1
// ==============================

const VAGARO_REGION = process.env.VAGARO_REGION || "us03";
const VAGARO_SCOPE = process.env.VAGARO_SCOPE || "read_access";
const VAGARO_BUSINESS_ID =
  process.env.VAGARO_BUSINESS_ID || "u70rCIZg8Li86bNB7KxwcA==";
const VAGARO_LUDIMILLA_PROVIDER_ID =
  process.env.VAGARO_LUDIMILLA_PROVIDER_ID || "b777Fo236wdourBe-n4dMw==";
const VAGARO_LISTING_URL =
  process.env.VAGARO_LISTING_URL || "https://www.vagaro.com/llbrows/book-now";

const VAGARO_BASE_URL = `https://api.vagaro.com/${VAGARO_REGION}`;

let vagaroTokenCache = {
  accessToken: null,
  expiresAt: 0
};

function isVagaroConfigured() {
  return Boolean(process.env.VAGARO_CLIENT_ID && process.env.VAGARO_CLIENT_SECRET);
}

async function getVagaroAccessToken() {
  if (!isVagaroConfigured()) {
    throw new Error("Vagaro credentials are missing in Render environment variables.");
  }

  const now = Date.now();

  if (
    vagaroTokenCache.accessToken &&
    vagaroTokenCache.expiresAt &&
    now < vagaroTokenCache.expiresAt - 60 * 1000
  ) {
    return vagaroTokenCache.accessToken;
  }

  const response = await fetch(
    `${VAGARO_BASE_URL}/api/v2/merchants/generate-access-token`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        clientId: process.env.VAGARO_CLIENT_ID,
        clientSecretKey: process.env.VAGARO_CLIENT_SECRET,
        scope: VAGARO_SCOPE
      })
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data?.status !== 200 || !data?.data?.access_token) {
    console.error("Erro gerando token Vagaro:", data);
    throw new Error(data?.message || "Could not generate Vagaro access token");
  }

  const expiresIn = Number(data.data.expires_in || 3600);

  vagaroTokenCache = {
    accessToken: data.data.access_token,
    expiresAt: Date.now() + expiresIn * 1000
  };

  return vagaroTokenCache.accessToken;
}

async function vagaroRequest(path, options = {}) {
  const accessToken = await getVagaroAccessToken();

  const response = await fetch(`${VAGARO_BASE_URL}${path}`, {
    method: options.method || "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      accessToken
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data?.status >= 400) {
    console.error("Erro Vagaro API:", {
      path,
      status: response.status,
      data
    });

    const message =
      data?.errors?.exception ||
      data?.message ||
      "Vagaro API request failed";

    throw new Error(message);
  }

  return data;
}

// ==============================
// VAGARO SERVICE MAP
// Only LLTouch.com services + Ludimilla
// ==============================

const VAGARO_ADD_ON_IDS = {
  led10: "kNd7Ae-L39CQL-pKNNWudA==",
  led20: "xjzjMUH2rz~9P8X7z6AZCA==",
  exosomes: "aqCIVAQTOBHy~JUD~dJUnA==",
  neck: "l6lQaQqf112TOf217gvVPg==",
  decollete: "8NpulR54BaxrMhXSwGnmTg==",
  "face-neck": "rQN1Iw400eiBYengNo9ovQ=="
};

const VAGARO_SERVICE_MAP = {
  morpheus: {
    serviceId: "86tRZDlMVXUbSNbbhqH9oA==",
    title: "Morpheus 8 consultation",
    category: "Morpheus8",
    durationMinutes: 15
  },

  facial: {
    "ll-signature": {
      serviceId: "YfqHkdJ4xlbojEnNytwnDA==",
      title: "LL Signature",
      category: "Facial Treatments",
      durationMinutes: 75
    },
    "classic-deluxe": {
      serviceId: "RaQGIo6sI~kcqab7fPeozg==",
      title: "LL Deluxe",
      category: "Facial Treatments",
      durationMinutes: 60
    }
    // "diamond-glow" and "dermaplaning" are new services with no Vagaro
    // serviceId yet. resolveVagaroServiceFromSiteItem() returns null for them
    // (safe no-op) until real Vagaro serviceIds are provided; the booking
    // flow falls back to VAGARO_LISTING_URL for those two.
  },

  "med-spa": {
    microneedling: {
      serviceId: "7qDQIfdCmFEk~7nIlCDP5A==",
      title: "Microneedling",
      category: "Med Spa Treatments",
      durationMinutes: 75
    },
    llumigold: {
      serviceId: "glQz6wa2UA1twxLJuhudOA==",
      title: "LLumiGold",
      category: "Med Spa Treatments",
      durationMinutes: 105
    },
    "oxi-laser-facial": {
      serviceId: "6mrUniAXL6KN~JRD5zFTLQ==",
      title: "Oxi Laser Facial",
      category: "Med Spa Treatments",
      durationMinutes: 15
    },
    "glow-up-laser-facial": {
      serviceId: "cnfidEsQRZ5Sl3KX9yNlCg==",
      title: "GlowUp Laser Facial (1 area)",
      category: "Med Spa Treatments",
      durationMinutes: 30
    },
    peel: {
      serviceId: "qb6EszkAXfgBgP441~vl2g==",
      title: "Brightening Glycolic Peel",
      category: "Peel",
      durationMinutes: 15
    }
    // "hydrafacial" is new, no Vagaro serviceId yet — same fallback behavior
    // as diamond-glow/dermaplaning above.
  },

  laser: {
    defaultByArea: {
      small: {
        serviceId: "J-HUz0ryZvEYUA~nzCopmA==",
        title: "Chin",
        category: "LHR-Small Area",
        durationMinutes: 15
      },
      medium: {
        serviceId: "aeHet9LRV-14nm5GaUWsdg==",
        title: "Under Arms",
        category: "LHR-Medium Area",
        durationMinutes: 15
      },
      large: {
        serviceId: "38t6KJORzDvPC-c1Ph75ug==",
        title: "Full Brazilian",
        category: "LHR-Large Area",
        durationMinutes: 15
      },
      xlarge: {
        serviceId: "jVv9Y2entpIc6r9pP8MuTQ==",
        title: "Full Back",
        category: "LHR-XLarge Area",
        durationMinutes: 25
      }
    },

    byServiceName: {
      chin: {
        serviceId: "J-HUz0ryZvEYUA~nzCopmA==",
        title: "Chin",
        category: "LHR-Small Area",
        durationMinutes: 15
      },
      ears: {
        serviceId: "m6Kw27c~L1aV-SmB8sGnQA==",
        title: "Ears",
        category: "LHR-Small Area",
        durationMinutes: 15
      },
      sideburns: {
        serviceId: "m78JQB3Q~iE7T56xoMiIKw==",
        title: "Sideburns",
        category: "LHR-Small Area",
        durationMinutes: 15
      },
      feet: {
        serviceId: "yj8PygSeR-aOZ8k1UMz0Ig==",
        title: "Feet",
        category: "LHR-Small Area",
        durationMinutes: 15
      },
      "men-bears": {
        serviceId: "uGdseQrv64wCPJQLcVpHgQ==",
        title: "Men Bears",
        category: "LHR-Small Area",
        durationMinutes: 15
      },
      "happy-trails": {
        serviceId: "OFdtiDZLOAFc10yCcYMKhQ==",
        title: "Happy Trails",
        category: "LHR-Small Area",
        durationMinutes: 15
      },
      areolas: {
        serviceId: "W-1lIaIrXM6ppQ3OAbF2PQ==",
        title: "Areolas",
        category: "LHR-Small Area",
        durationMinutes: 15
      },
      jawline: {
        serviceId: "3x-7NdSEwDw68zH~rUXAhA==",
        title: "Jawline",
        category: "LHR-Small Area",
        durationMinutes: 15
      },
      "bikini-line": {
        serviceId: "Q1~u1T0FnFiYTlla~~8m7Q==",
        title: "Bikini Line",
        category: "LHR-Medium Area",
        durationMinutes: 15
      },
      "under-arms": {
        serviceId: "aeHet9LRV-14nm5GaUWsdg==",
        title: "Under Arms",
        category: "LHR-Medium Area",
        durationMinutes: 15
      },
      shoulders: {
        serviceId: "fzFWc-OKl5tWCNL7KAoniw==",
        title: "Shoulders",
        category: "LHR-Medium Area",
        durationMinutes: 15
      },
      "neck-front": {
        serviceId: "DuQHi0wt8Sicym0zTuI4wQ==",
        title: "Neck-Front",
        category: "LHR-Medium Area",
        durationMinutes: 15
      },
      "neck-back": {
        serviceId: "XhI3QEk8QU4rK8D6deuByg==",
        title: "Neck-Back",
        category: "LHR-Medium Area",
        durationMinutes: 15
      },
      "arms-lower": {
        serviceId: "gj2ZDmTIasi~eIDmnJcQtw==",
        title: "Arms-Lower",
        category: "LHR-Medium Area",
        durationMinutes: 15
      },
      "arms-upper": {
        serviceId: "oUtk5u4rGlP3~4DYDcpQgg==",
        title: "Arms-Upper",
        category: "LHR-Medium Area",
        durationMinutes: 15
      },
      "full-brazilian": {
        serviceId: "38t6KJORzDvPC-c1Ph75ug==",
        title: "Full Brazilian",
        category: "LHR-Large Area",
        durationMinutes: 15
      },
      "full-face": {
        serviceId: "10bcP6KOfgrIFq3b6DjwIQ==",
        title: "Full Face",
        category: "LHR-Large Area",
        durationMinutes: 15
      },
      buttocks: {
        serviceId: "s6HaxBtKSDBtFf7cKZfThg==",
        title: "Buttocks",
        category: "LHR-Large Area",
        durationMinutes: 15
      },
      abdomen: {
        serviceId: "uubgg1LFS4y11g5IzMqNjA==",
        title: "Abdomen",
        category: "LHR-Large Area",
        durationMinutes: 15
      },
      chest: {
        serviceId: "Sphi7d7TbguA9TM5hHjPaQ==",
        title: "Chest",
        category: "LHR-Large Area",
        durationMinutes: 15
      },
      "back-half": {
        serviceId: "di2NWM70ja9E8RBsS79AFw==",
        title: "Back-Half",
        category: "LHR-Large Area",
        durationMinutes: 15
      },
      "back-lower": {
        serviceId: "5VVQ0cDxI4RaZfJnc1u3mg==",
        title: "Back-Lower",
        category: "LHR-Large Area",
        durationMinutes: 15
      },
      "legs-lower": {
        serviceId: "mkq2R6sLFGZLt4mmkibvBg==",
        title: "Legs-Lower",
        category: "LHR-Large Area",
        durationMinutes: 15
      },
      "legs-upper": {
        serviceId: "W8kD7lwRwUwJ65DbU~mSzg==",
        title: "Legs-Upper",
        category: "LHR-Large Area",
        durationMinutes: 15
      },
      "full-back": {
        serviceId: "jVv9Y2entpIc6r9pP8MuTQ==",
        title: "Full Back",
        category: "LHR-XLarge Area",
        durationMinutes: 25
      },
      "full-legs": {
        serviceId: "JxUxYDhjxwO~7wWXhkt6zg==",
        title: "Full Legs",
        category: "LHR-XLarge Area",
        durationMinutes: 25
      },
      "full-arms": {
        serviceId: "ecn~58vkCBMIAoqG-pVDww==",
        title: "Full Arms",
        category: "LHR-XLarge Area",
        durationMinutes: 25
      },
      "full-chest": {
        serviceId: "KyG7G6EvsZnty08awgBUPg==",
        title: "Full Chest",
        category: "LHR-XLarge Area",
        durationMinutes: 25
      }
    }
  },

  "full-body": {
    serviceId: "81NqSI53~w4sKenWUsflzg==",
    title: "Full Body - 6 areas",
    category: "Payments",
    durationMinutes: 15
  }
};

function resolveVagaroAddOns(siteItem = {}) {
  const addon = normalizeKey(siteItem.addon || siteItem.addonKey || "");

  if (!addon || addon === "none") return [];

  const addOns = [];

  if (addon.includes("led10")) addOns.push(VAGARO_ADD_ON_IDS.led10);
  if (addon.includes("led20")) addOns.push(VAGARO_ADD_ON_IDS.led20);
  if (addon.includes("exosomes") || addon.includes("exo")) {
    addOns.push(VAGARO_ADD_ON_IDS.exosomes);
  }
  if (addon.includes("neck")) addOns.push(VAGARO_ADD_ON_IDS.neck);
  if (addon.includes("decollete")) addOns.push(VAGARO_ADD_ON_IDS.decollete);

  return [...new Set(addOns.filter(Boolean))];
}

function resolveVagaroServiceFromSiteItem(siteItem = {}) {
  const type = siteItem.type;

  if (type === "morpheus") {
    return {
      ...VAGARO_SERVICE_MAP.morpheus,
      addOnIds: []
    };
  }

  if (type === "facial") {
    const serviceKey = siteItem.service || siteItem.serviceKey;
    const service = VAGARO_SERVICE_MAP.facial[serviceKey];

    if (!service) return null;

    return {
      ...service,
      addOnIds: resolveVagaroAddOns(siteItem)
    };
  }

  if (type === "med-spa") {
    const serviceKey = siteItem.service || siteItem.serviceKey;
    const service = VAGARO_SERVICE_MAP["med-spa"][serviceKey];

    if (!service) return null;

    return {
      ...service,
      addOnIds: resolveVagaroAddOns(siteItem)
    };
  }

  if (type === "laser") {
    const exactName =
      siteItem.service ||
      siteItem.serviceTitle ||
      siteItem.title ||
      siteItem.areaName ||
      "";

    const exactKey = normalizeKey(exactName);
    const exact = VAGARO_SERVICE_MAP.laser.byServiceName[exactKey];

    if (exact) {
      return {
        ...exact,
        addOnIds: []
      };
    }

    const area = normalizeKey(siteItem.area || siteItem.areaSize);
    const fallback = VAGARO_SERVICE_MAP.laser.defaultByArea[area];

    if (!fallback) return null;

    return {
      ...fallback,
      addOnIds: []
    };
  }

  if (type === "full-body") {
    return {
      ...VAGARO_SERVICE_MAP["full-body"],
      addOnIds: []
    };
  }

  return null;
}

// ==============================
// PRICE ID → SITE ITEM MAP
// ==============================

const PRICE_ID_TO_SITE_ITEM = new Map();

function addPriceMapping(priceId, siteItem) {
  if (priceId) {
    PRICE_ID_TO_SITE_ITEM.set(priceId, siteItem);
  }
}

for (const [area, packages] of Object.entries(priceMap.laser)) {
  for (const [pkg, priceId] of Object.entries(packages)) {
    addPriceMapping(priceId, {
      type: "laser",
      area,
      package: pkg
    });
  }
}

for (const [pkg, addons] of Object.entries(priceMap["full-body"])) {
  for (const [addon, priceId] of Object.entries(addons)) {
    addPriceMapping(priceId, {
      type: "full-body",
      package: pkg,
      addon
    });
  }
}

// Facial, med-spa and membership no longer use pre-created Stripe Price IDs
// (see FACIAL_BASE_PRICES / MEDSPA_BASE_PRICES / MEMBERSHIP_PLANS above) — a
// completed session's line item is reconstructed via product metadata
// instead. See siteItemFromLineItem().

function buildPrimarySiteItemMetadata(items = []) {
  const first = items.find((item) => {
    const vagaro = resolveVagaroServiceFromSiteItem(item);
    return Boolean(vagaro);
  });

  if (!first) return "";

  const compact = {
    type: first.type,
    service: first.service,
    serviceKey: first.serviceKey,
    area: first.area,
    areaSize: first.areaSize,
    package: first.package,
    key: first.key,
    addon: first.addon,
    title: first.title
  };

  return JSON.stringify(compact).slice(0, 490);
}

function siteItemFromLineItem(lineItem) {
  const priceId = lineItem.price?.id;
  const mapped = PRICE_ID_TO_SITE_ITEM.get(priceId);

  if (mapped) {
    return { ...mapped };
  }

  const product = lineItem.price?.product || {};
  const metadata = product.metadata || {};

  // Facial / med-spa / membership / morpheus are all dynamic price_data line
  // items (no fixed Price ID to look up above) — reconstruct the site item
  // from the product metadata we set when the session was created.
  if (metadata.source === "lltouch-site") {
    if (metadata.mode === "morpheus") {
      return { type: "morpheus" };
    }

    if (metadata.mode === "facial") {
      return {
        type: "facial",
        service: metadata.service,
        package: metadata.package,
        addon: metadata.addon
      };
    }

    if (metadata.mode === "med-spa") {
      return {
        type: "med-spa",
        service: metadata.service,
        package: metadata.package,
        addon: metadata.addon
      };
    }

    if (metadata.mode === "membership") {
      return {
        type: "membership",
        plan: metadata.plan,
        package: metadata.package
      };
    }
  }

  const productName = String(product.name || "");

  if (
    normalizeKey(productName).includes("morpheus8-consultation") ||
    normalizeKey(productName).includes("morpheus-8-consultation") ||
    product.metadata?.source === "morpheus-landing-form"
  ) {
    return {
      type: "morpheus"
    };
  }

  return null;
}

function buildBookingOptionsFromSession(session) {
  const options = [];
  const seen = new Set();

  const primaryFromMetadata = safeJsonParse(session.metadata?.primary_site_item, null);

  if (primaryFromMetadata) {
    const service = resolveVagaroServiceFromSiteItem(primaryFromMetadata);

    if (service && !seen.has(service.serviceId)) {
      seen.add(service.serviceId);
      options.push({
        index: options.length,
        source: "session_metadata",
        siteItem: primaryFromMetadata,
        vagaroService: service,
        professional: {
          name: "Ludimilla Leite",
          serviceProviderId: VAGARO_LUDIMILLA_PROVIDER_ID
        }
      });
    }
  }

  const lineItems = session.line_items?.data || [];

  for (const lineItem of lineItems) {
    const siteItem = siteItemFromLineItem(lineItem);
    if (!siteItem) continue;

    const service = resolveVagaroServiceFromSiteItem(siteItem);
    if (!service || seen.has(service.serviceId)) continue;

    seen.add(service.serviceId);

    options.push({
      index: options.length,
      source: "line_item",
      stripePriceId: lineItem.price?.id || null,
      stripeProductName: lineItem.price?.product?.name || null,
      siteItem,
      vagaroService: service,
      professional: {
        name: "Ludimilla Leite",
        serviceProviderId: VAGARO_LUDIMILLA_PROVIDER_ID
      }
    });
  }

  return options;
}

// ==============================
// PRICE / CHECKOUT LOGIC
// ==============================

// Only laser / full-body still reference pre-created Stripe Price IDs.
// Facial / med-spa / membership / morpheus are priced dynamically — see
// getFacialPrice() / getMedSpaPrice() / getMembershipPrice() / consultation
// fee handling inline in /create-checkout-session.
function resolvePriceId(item) {
  try {
    if (item.type === "laser") return priceMap.laser?.[item.area]?.[item.package];
    if (item.type === "full-body") return priceMap["full-body"]?.[item.package]?.[item.addon || "none"];

    return null;
  } catch {
    return null;
  }
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

// Computes an item's dollar amount without ever hitting Stripe — laser/
// full-body use the local dollar mirror (real prices unchanged), everything
// else uses its own dynamic-pricing helper.
function computeLocalItemAmount(item) {
  const quantity = item.quantity || 1;

  if (item.type === "morpheus") return MORPHEUS_CONSULTATION_FEE * quantity;
  if (item.type === "facial") return getFacialPrice(item).amount * quantity;
  if (item.type === "med-spa") return getMedSpaPrice(item).amount * quantity;
  if (item.type === "membership") return getMembershipPrice(item).amount * quantity;
  if (item.type === "laser") return (LASER_DOLLAR_PRICES[item.area]?.[item.package] || 0) * quantity;
  if (item.type === "full-body") {
    return (FULL_BODY_DOLLAR_PRICES[item.package]?.[item.addon || "none"] || 0) * quantity;
  }

  return 0;
}

async function resolveDiscounts(customer, items) {
  let hasFacial = false;
  let hasMicroneedlingSingle = false;
  let currentFacialPurchase = 0;

  for (const item of items) {
    if (item.type === "facial") {
      hasFacial = true;
      currentFacialPurchase += getFacialPrice(item).amount * (item.quantity || 1);
    }

    if (
      item.type === "med-spa" &&
      item.service === "microneedling" &&
      getMedSpaPackageKey(item) === "single" &&
      (!item.addon || item.addon === "none")
    ) {
      hasMicroneedlingSingle = true;
    }
  }

  // Note: the old "membership platinum" and "other-service combo-full-face"
  // auto-coupons were removed along with the Platinum/Gold/Teen plans and
  // the Other Services page — those Stripe coupons (thCriSEx, oLmALLlo) are
  // now unused but were left untouched in the Stripe Dashboard.

  if (customer.popup_unlocked && !customer.first_purchase_used) {
    return {
      discounts: [{ coupon: "jmx11QWL" }],
      metadata: { discount_type: "first_purchase" }
    };
  }

  if (hasMicroneedlingSingle && !customer.microneedling_discount_used) {
    return {
      discounts: [{ coupon: "U2VFw8Yj" }],
      metadata: { discount_type: "microneedling" }
    };
  }

  if (hasFacial) {
    let discountTier = 0;

    if (currentFacialPurchase >= 1500) discountTier = 10;
    else if (currentFacialPurchase >= 600) discountTier = 7;
    else if (currentFacialPurchase >= 300) discountTier = 5;

    if (discountTier > 0) {
      const couponMap = {
        10: "xu5jbAdc",
        7: "vwkWvHPm",
        5: "nzcBZv4q"
      };

      return {
        discounts: [{ coupon: couponMap[discountTier] }],
        metadata: { discount_type: "facial" }
      };
    }
  }

  if (customer.cashback_balance > 0) {
    const currentCartTotal = items.reduce(
      (acc, item) => acc + computeLocalItemAmount(item),
      0
    );

    const maxAllowedDiscount = currentCartTotal * 0.5;

    const finalCashbackAmount = Math.min(
      Number(customer.cashback_balance || 0),
      maxAllowedDiscount
    );

    if (finalCashbackAmount > 0) {
      const coupon = await stripe.coupons.create({
        amount_off: Math.round(finalCashbackAmount * 100),
        currency: "usd",
        duration: "once",
        name: "Cashback Used (Max 50%)"
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

// ==============================
// VAGARO HELPERS
// ==============================

async function getStripeSessionExpanded(sessionId) {
  return stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["line_items.data.price.product"]
  });
}

async function searchVagaroAvailability({ date, serviceId, addOnIds = [] }) {
  const body = {
    businessId: VAGARO_BUSINESS_ID,
    appointmentDate: date,
    bookingItems: [
      {
        serviceId,
        addOnIds: Array.isArray(addOnIds) ? addOnIds : [],
        serviceProviderIds: [VAGARO_LUDIMILLA_PROVIDER_ID]
      }
    ]
  };

  const data = await vagaroRequest("/api/v2/appointments/availability", {
    method: "POST",
    body
  });

  const availability = Array.isArray(data?.data) ? data.data : [];

  const normalized = availability.map((day) => ({
    vagaroUrl: day.vagaroUrl || "llbrows",
    appointmentDate: day.appointmentDate,
    items: day.items || [],
    timeSlot: Array.isArray(day.timeSlot) ? day.timeSlot : []
  }));

  return {
    status: data.status,
    responseCode: data.responseCode,
    message: data.message,
    data: normalized
  };
}

// ==============================
// ROUTES - CUSTOMER / CASHBACK / SESSION
// ==============================

app.post("/cashback-preview", (req, res) => {
  try {
    const { cart } = req.body;

    if (!cart || !Array.isArray(cart)) {
      return res.json({
        cashback: 0,
        rate: 0,
        tier: "Bronze"
      });
    }

    const laserSubtotal = cart.reduce((acc, item) => {
      if (item.mode === "laser" || item.mode === "full-body") {
        const qty = item.quantity || 1;
        return acc + item.price * qty;
      }

      return acc;
    }, 0);

    let rate = 0;
    let tier = "Bronze";

    if (laserSubtotal >= 3000) {
      rate = 0.10;
      tier = "Gold";
    } else if (laserSubtotal >= 1500) {
      rate = 0.07;
      tier = "Silver";
    } else if (laserSubtotal >= 500) {
      rate = 0.05;
      tier = "Bronze";
    }

    res.json({
      cashback: Number((laserSubtotal * rate).toFixed(2)),
      rate,
      tier,
      laserSubtotal
    });
  } catch (err) {
    console.error("Erro /cashback-preview:", err);
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
    const session = await getStripeSessionExpanded(req.params.id);

    const items = session.line_items.data.map((item, index) => {
      const product = item.price.product;
      const siteItem = siteItemFromLineItem(item);
      const vagaroService = siteItem ? resolveVagaroServiceFromSiteItem(siteItem) : null;

      return {
        index,
        name: product.name,
        description: product.description || "",
        amount: item.amount_total / 100,
        unit_amount: item.price.unit_amount ? item.price.unit_amount / 100 : null,
        quantity: item.quantity || 1,
        currency: item.currency,
        price_id: item.price.id || null,
        product_id: product.id || null,
        product_metadata: product.metadata || {},
        site_item: siteItem,
        vagaro_service: vagaroService
          ? {
              serviceId: vagaroService.serviceId,
              title: vagaroService.title,
              category: vagaroService.category,
              durationMinutes: vagaroService.durationMinutes
            }
          : null
      };
    });

    const bookingOptions = buildBookingOptionsFromSession(session).map((option) => ({
      index: option.index,
      source: option.source,
      siteItem: option.siteItem,
      serviceId: option.vagaroService.serviceId,
      serviceTitle: option.vagaroService.title,
      category: option.vagaroService.category,
      durationMinutes: option.vagaroService.durationMinutes,
      professional: option.professional,
      fallbackUrl: VAGARO_LISTING_URL
    }));

    res.json({
      id: session.id,
      email: session.customer_details?.email,
      payment_status: session.payment_status,
      total: session.amount_total / 100,
      subtotal: session.amount_subtotal ? session.amount_subtotal / 100 : null,
      currency: session.currency,
      metadata: session.metadata || {},
      items,
      booking_options: bookingOptions,
      fallback_booking_url: VAGARO_LISTING_URL
    });
  } catch (err) {
    console.error("Erro buscando sessão:", err);
    res.status(500).json({ error: "Erro ao buscar sessão" });
  }
});

// ==============================
// ROUTES - CHECKOUT
// ==============================

app.post("/llb/create-checkout-session", checkoutLimiter, async (req, res) => {
  try {
    const email = cleanLeadField(req.body?.email, 254).toLowerCase();
    const items = req.body?.items;

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Enter a valid checkout email." });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Your service bag is empty." });
    }

    if (items.length > 10) {
      return res.status(400).json({ error: "Too many services in the bag." });
    }

    const seen = new Set();
    const normalizedItems = [];

    for (const item of items) {
      const serviceKey = cleanLeadField(item?.serviceKey, 100);
      const service = LLB_SERVICES[serviceKey];
      const quantity = Number(item?.quantity || item?.qty || 1);

      if (!service) {
        return res.status(400).json({
          error: `This LL Brows service cannot be purchased online: ${serviceKey || "unknown"}.`
        });
      }

      if (seen.has(serviceKey)) {
        return res.status(400).json({
          error: `The service ${service.name} appears more than once.`
        });
      }

      // Appointment services should be purchased once per checkout.
      if (!Number.isInteger(quantity) || quantity !== 1) {
        return res.status(400).json({
          error: `Invalid quantity for ${service.name}.`
        });
      }

      seen.add(serviceKey);
      normalizedItems.push({ serviceKey, service, quantity });
    }

    const successUrl = getLLBrowsCheckoutUrl("LLB_CHECKOUT_SUCCESS_URL");
    const cancelUrl = getLLBrowsCheckoutUrl("LLB_CHECKOUT_CANCEL_URL");
    const serviceKeys = normalizedItems.map((item) => item.serviceKey).join(",");

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      line_items: normalizedItems.map(({ serviceKey, service, quantity }) =>
        createLLBrowsLineItem(serviceKey, service, quantity)
      ),
      billing_address_collection: "auto",
      phone_number_collection: { enabled: true },
      metadata: {
        brand: "ll_brows",
        source: "ll_brows_webflow",
        service_keys: serviceKeys.slice(0, 500)
      },
      payment_intent_data: {
        metadata: {
          brand: "ll_brows",
          source: "ll_brows_webflow",
          service_keys: serviceKeys.slice(0, 500)
        }
      },
      success_url: successUrl,
      cancel_url: cancelUrl
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("Erro LL Brows checkout:", error);

    const publicMessage = String(error?.message || "").includes("must be configured")
      ? "LL Brows checkout URLs are not configured on the server."
      : "Unable to create the LL Brows checkout session.";

    res.status(500).json({ error: publicMessage });
  }
});

app.post("/create-checkout-session", checkoutLimiter, async (req, res) => {
  try {
    const { email, items } = req.body;

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

      const quantity = Number(item.quantity || item.qty) || 1;

      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ITEM_QUANTITY) {
        return res.status(400).json({ error: "Invalid quantity" });
      }
    }

    const customer = await getOrCreateCustomer(email);

    const line_items = items.map((item) => {
      if (item.type === "morpheus") {
        const consultationFee = MORPHEUS_CONSULTATION_FEE;
        const services = item.services || {};

        let servicesText = "";

        if (services.morpheus && services.morpheus.length) {
          servicesText += `Morpheus8: ${services.morpheus.join(", ")}. `;
        }

        if (services.body && services.body.length) {
          servicesText += `Morpheus8 Body: ${services.body.join(", ")}. `;
        }

        if (services.lumecca && services.lumecca.length) {
          servicesText += `Lumecca (IPL): ${services.lumecca.join(", ")}. `;
        }

        return {
          price_data: {
            currency: "usd",
            product_data: {
              name: "Morpheus8 Consultation",
              description: `${servicesText}$50 Reservation Fee – Applied toward treatment`,
              images: [
                "https://cdn.prod.website-files.com/65de549be003197a7c137f6b/699f468b700aaf1a46a3263e_WhatsApp%20Image%202026-02-25%20at%2015.58.50.jpeg"
              ],
              metadata: {
                source: "lltouch-site",
                mode: "morpheus",
                morpheus: services.morpheus?.join(", ") || "",
                body: services.body?.join(", ") || "",
                lumecca: services.lumecca?.join(", ") || ""
              }
            },
            unit_amount: consultationFee * 100
          },
          quantity: 1
        };
      }

      if (item.type === "facial") {
        const priced = getFacialPrice(item);
        const description =
          priced.addon && priced.addon !== "none"
            ? `${priced.packageLabel} + ${priced.addonLabel}`
            : priced.packageLabel;

        return {
          quantity: item.quantity || 1,
          price_data: {
            currency: "usd",
            unit_amount: Math.round(priced.amount * 100),
            product_data: {
              name: priced.name,
              description,
              metadata: {
                source: "lltouch-site",
                mode: "facial",
                service: item.service,
                package: priced.package,
                addon: priced.addon
              }
            }
          }
        };
      }

      if (item.type === "med-spa") {
        const priced = getMedSpaPrice(item);
        const description =
          priced.addon && priced.addon !== "none"
            ? `${priced.packageLabel} + ${priced.addonLabel}`
            : priced.packageLabel;

        return {
          quantity: item.quantity || 1,
          price_data: {
            currency: "usd",
            unit_amount: Math.round(priced.amount * 100),
            product_data: {
              name: priced.name,
              description,
              metadata: {
                source: "lltouch-site",
                mode: "med-spa",
                service: item.service,
                package: priced.package,
                addon: priced.addon
              }
            }
          }
        };
      }

      if (item.type === "membership") {
        const priced = getMembershipPrice(item);

        return {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: Math.round(priced.amount * 100),
            product_data: {
              name: priced.name,
              description: `$${priced.monthlyPrice}/month × ${priced.months} months (6-month commitment)`,
              metadata: {
                source: "lltouch-site",
                mode: "membership",
                plan: item.plan,
                package: "6"
              }
            }
          }
        };
      }

      const priceId = resolvePriceId(item);

      if (!priceId) {
        throw new Error("Produto inválido");
      }

      return {
        price: priceId,
        quantity: item.quantity || 1
      };
    });

    const { discounts, metadata } = await resolveDiscounts(customer, items);
    const hasAutoDiscount = discounts && discounts.length > 0;
    const onlyMorpheus = items.every((item) => item.type === "morpheus");
    const cashbackUsedAmount = metadata?.cashback_used_amount || 0;

    const primarySiteItem = buildPrimarySiteItemMetadata(items);

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
        cart_items_count: String(items.length),
        cashback_used_amount: String(cashbackUsedAmount),
        primary_site_item: primarySiteItem,
        ...metadata
      },

      success_url: "https://lltouch.com/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://lltouch.com/cancel"
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("Erro checkout:", error);
    res.status(500).json({ error: "Erro ao criar sessão" });
  }
});

app.post("/create-morpheus-direct-checkout", checkoutLimiter, async (req, res) => {
  try {
    const email = cleanLeadField(req.body.email, 120).toLowerCase();
    const fullName = cleanLeadField(req.body.fullName, 120);
    const phoneNumber = cleanLeadField(req.body.phoneNumber, 60);
    const preferredContact = cleanLeadField(req.body.preferredContact, 40);
    const goals = cleanLeadField(req.body.goals, 400);
    const sourcePage = cleanLeadField(req.body.sourcePage, 180);

    const areasOfConcern = Array.isArray(req.body.areasOfConcern)
      ? req.body.areasOfConcern
          .map((item) => cleanLeadField(item, 60))
          .filter(Boolean)
          .join(", ")
      : cleanLeadField(req.body.areasOfConcern, 300);

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email" });
    }

    if (!fullName || !phoneNumber || !preferredContact) {
      return res.status(400).json({ error: "Missing required form fields" });
    }

    const descriptionParts = [
      "$50 Reservation Fee – Applied toward treatment",
      fullName ? `Name: ${fullName}` : "",
      phoneNumber ? `Phone: ${phoneNumber}` : "",
      preferredContact ? `Preferred Contact: ${preferredContact}` : "",
      areasOfConcern ? `Areas of Concern: ${areasOfConcern}` : "",
      goals ? `Goals: ${goals}` : ""
    ].filter(Boolean);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      allow_promotion_codes: true,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "Morpheus8 Consultation",
              description: descriptionParts.join(" | ").slice(0, 500),
              images: [
                "https://cdn.prod.website-files.com/65de549be003197a7c137f6b/699f468b700aaf1a46a3263e_WhatsApp%20Image%202026-02-25%20at%2015.58.50.jpeg"
              ],
              metadata: {
                source: "morpheus-landing-form",
                mode: "morpheus",
                full_name: fullName,
                phone_number: phoneNumber,
                preferred_contact: preferredContact,
                areas_of_concern: areasOfConcern,
                goals
              }
            },
            unit_amount: MORPHEUS_CONSULTATION_FEE * 100
          },
          quantity: 1
        }
      ],
      metadata: {
        source: "morpheus-landing-form",
        source_page: sourcePage,
        customer_email: email,
        full_name: fullName,
        phone_number: phoneNumber,
        preferred_contact: preferredContact,
        areas_of_concern: areasOfConcern,
        goals,
        primary_site_item: JSON.stringify({ type: "morpheus" })
      },
      success_url: "https://lltouch.com/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://lltouch.com/cancel"
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("Erro direct morpheus checkout:", error);
    res.status(500).json({ error: "Erro ao criar sessão" });
  }
});

// ==============================
// ROUTES - VAGARO FASE 1
// ==============================

app.post("/vagaro/availability", checkoutLimiter, async (req, res) => {
  try {
    const sessionId = cleanLeadField(req.body.session_id, 120);
    const date = formatDateOnly(req.body.date);
    const selectedIndex = Number.isInteger(Number(req.body.item_index))
      ? Number(req.body.item_index)
      : 0;

    if (!sessionId) {
      return res.status(400).json({ error: "Missing session_id" });
    }

    if (!date) {
      return res.status(400).json({
        error: "Invalid date. Use YYYY-MM-DD."
      });
    }

    const session = await getStripeSessionExpanded(sessionId);

    if (session.payment_status !== "paid") {
      return res.status(403).json({
        error: "Payment is not confirmed yet."
      });
    }

    const bookingOptions = buildBookingOptionsFromSession(session);

    if (!bookingOptions.length) {
      return res.status(400).json({
        error: "No supported LLTouch booking service found for this order.",
        fallbackUrl: VAGARO_LISTING_URL
      });
    }

    const selected = bookingOptions[selectedIndex] || bookingOptions[0];

    const availability = await searchVagaroAvailability({
      date,
      serviceId: selected.vagaroService.serviceId,
      addOnIds: selected.vagaroService.addOnIds || []
    });

    const slots = availability.data.flatMap((day) =>
      (day.timeSlot || []).map((time) => ({
        date: day.appointmentDate,
        time,
        professional: "Ludimilla Leite",
        serviceProviderId: VAGARO_LUDIMILLA_PROVIDER_ID,
        serviceId: selected.vagaroService.serviceId,
        serviceTitle: selected.vagaroService.title
      }))
    );

    res.json({
      status: 200,
      message: "Success",
      session_id: session.id,
      date,
      service: {
        serviceId: selected.vagaroService.serviceId,
        title: selected.vagaroService.title,
        category: selected.vagaroService.category,
        durationMinutes: selected.vagaroService.durationMinutes,
        addOnIds: selected.vagaroService.addOnIds || []
      },
      professional: {
        name: "Ludimilla Leite",
        serviceProviderId: VAGARO_LUDIMILLA_PROVIDER_ID
      },
      slots,
      rawAvailability: availability.data,
      fallbackUrl: VAGARO_LISTING_URL,
      note:
        "Vagaro API returned availability. Final appointment confirmation must happen through Vagaro because Create Appointment is not available in this API access level."
    });
  } catch (err) {
    console.error("Erro /vagaro/availability:", err);

    res.status(500).json({
      error: "Could not load Vagaro availability",
      details: err.message,
      fallbackUrl: VAGARO_LISTING_URL
    });
  }
});

app.get("/vagaro/booking-options/:sessionId", async (req, res) => {
  try {
    const session = await getStripeSessionExpanded(req.params.sessionId);

    const bookingOptions = buildBookingOptionsFromSession(session).map((option) => ({
      index: option.index,
      source: option.source,
      siteItem: option.siteItem,
      serviceId: option.vagaroService.serviceId,
      serviceTitle: option.vagaroService.title,
      category: option.vagaroService.category,
      durationMinutes: option.vagaroService.durationMinutes,
      professional: option.professional,
      fallbackUrl: VAGARO_LISTING_URL
    }));

    res.json({
      status: 200,
      session_id: session.id,
      payment_status: session.payment_status,
      booking_options: bookingOptions,
      fallbackUrl: VAGARO_LISTING_URL
    });
  } catch (err) {
    console.error("Erro /vagaro/booking-options:", err);
    res.status(500).json({
      error: "Could not load booking options",
      details: err.message
    });
  }
});

app.post("/vagaro/webhook", async (req, res) => {
  try {
    const configuredToken = process.env.VAGARO_WEBHOOK_TOKEN;

    if (configuredToken) {
      const receivedToken =
        req.headers["x-vagaro-token"] ||
        req.headers["x-vagaro-webhook-token"] ||
        req.headers["verification-token"] ||
        String(req.headers.authorization || "").replace(/^Bearer\s+/i, "") ||
        req.query.token;

      if (receivedToken !== configuredToken) {
        return res.status(401).json({ error: "Invalid Vagaro webhook token" });
      }
    }

    console.log("Vagaro webhook recebido:", JSON.stringify(req.body).slice(0, 2000));

    res.json({ received: true });
  } catch (err) {
    console.error("Erro /vagaro/webhook:", err);
    res.status(500).json({ error: "Webhook error" });
  }
});

// ==============================
// ROUTES - POPUP
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
// HEALTH ROUTES
// ==============================

app.get("/", (_, res) => {
  res.send("LL Touch + LL Brows Stripe/Vagaro API running 🚀");
});

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    stripe: Boolean(process.env.STRIPE_SECRET_KEY),
    llBrows: {
      checkoutRoute: "/llb/create-checkout-session",
      successUrlConfigured: Boolean(process.env.LLB_CHECKOUT_SUCCESS_URL),
      cancelUrlConfigured: Boolean(process.env.LLB_CHECKOUT_CANCEL_URL)
    },
    supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_KEY),
    vagaro: {
      configured: isVagaroConfigured(),
      region: VAGARO_REGION,
      scope: VAGARO_SCOPE,
      businessId: VAGARO_BUSINESS_ID,
      professional: "Ludimilla Leite"
    }
  });
});

// ==============================
// SERVER START
// ==============================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});