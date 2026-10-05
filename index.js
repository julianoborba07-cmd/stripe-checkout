import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";

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

// LL Brows Academy uses a backend-only service-role key when available.
// This is deliberately separate from the existing LL Touch Supabase client.
const academySupabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
);

// ==============================
// CUSTOMER HELPERS
// ==============================

function buildFallbackCustomer(email = "") {
  return {
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
  };
}

async function getOrCreateCustomer(email) {
  const fallbackCustomer = buildFallbackCustomer(email);

  try {
    const { data: customer, error: selectError } = await supabase
      .from("customers")
      .select("*")
      .eq("email", email)
      .maybeSingle();

    if (selectError) {
      console.error("Supabase customer lookup failed; checkout will continue without VIP/cashback discounts:", selectError);
      return fallbackCustomer;
    }

    if (customer) {
      return customer;
    }

    const { data: createdCustomer, error: insertError } = await supabase
      .from("customers")
      .insert([fallbackCustomer])
      .select()
      .single();

    if (insertError || !createdCustomer) {
      console.error("Supabase customer creation failed; checkout will continue without VIP/cashback discounts:", insertError);
      return fallbackCustomer;
    }

    return createdCustomer;
  } catch (err) {
    console.error("Supabase customer helper failed; checkout will continue without VIP/cashback discounts:", err);
    return fallbackCustomer;
  }
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

// ==============================
// LL BROWS ACADEMY / GOOGLE CALENDAR
// Added independently from LL Touch checkout/Vagaro booking logic.
// ==============================

const VAGARO_ACADEMY_SERVICE_ID = "B15PxW3jHP3aZ9eO7JyaPA==";
const VAGARO_ACADEMY_SERVICE_TITLE = "45 min Discovery Call - LL Brows Academy –";
const VAGARO_ACADEMY_DURATION_MINUTES = 45;

const GOOGLE_SERVICE_ACCOUNT_EMAIL =
  String(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "").trim();

const GOOGLE_PRIVATE_KEY =
  String(process.env.GOOGLE_PRIVATE_KEY || "")
    .replace(/\\n/g, "\n")
    .trim();

const GOOGLE_CALENDAR_ID =
  String(process.env.GOOGLE_CALENDAR_ID || "").trim();

const GOOGLE_CALENDAR_TIMEZONE =
  String(process.env.GOOGLE_CALENDAR_TIMEZONE || "America/New_York").trim();

let googleAccessTokenCache = {
  accessToken: null,
  expiresAt: 0
};

// ==============================
// LL BROWS ACADEMY - PERSISTENCE / NOTIFICATIONS
// ==============================

const RESEND_API_KEY = String(process.env.RESEND_API_KEY || "").trim();
const ACADEMY_EMAIL_FROM = String(process.env.ACADEMY_EMAIL_FROM || "").trim();
const ACADEMY_REPLY_TO_EMAIL = String(
  process.env.ACADEMY_REPLY_TO_EMAIL || ""
).trim();

const TWILIO_ACCOUNT_SID = String(
  process.env.TWILIO_ACCOUNT_SID || ""
).trim();
const TWILIO_AUTH_TOKEN = String(
  process.env.TWILIO_AUTH_TOKEN || ""
).trim();
const TWILIO_FROM_NUMBER = String(
  process.env.TWILIO_FROM_NUMBER || ""
).trim();
const TWILIO_MESSAGING_SERVICE_SID = String(
  process.env.TWILIO_MESSAGING_SERVICE_SID || ""
).trim();

// LL Brows Academy - Zoom Server-to-Server OAuth
const ZOOM_ACCOUNT_ID = String(process.env.ZOOM_ACCOUNT_ID || "").trim();
const ZOOM_CLIENT_ID = String(process.env.ZOOM_CLIENT_ID || "").trim();
const ZOOM_CLIENT_SECRET = String(process.env.ZOOM_CLIENT_SECRET || "").trim();
const ZOOM_HOST_EMAIL = String(process.env.ZOOM_HOST_EMAIL || "").trim();

let zoomAccessTokenCache = {
  accessToken: null,
  expiresAt: 0
};

const ACADEMY_PRECALL_URL = String(
  process.env.ACADEMY_PRECALL_URL ||
  "https://www.llbrows.com/pre-call"
).trim();

const ACADEMY_CRON_SECRET = String(
  process.env.ACADEMY_CRON_SECRET || ""
).trim();

const WEB3FORMS_ACCESS_KEY = String(
  process.env.WEB3FORMS_ACCESS_KEY || ""
).trim();

const ACADEMY_INTERNAL_EMAIL = String(
  process.env.ACADEMY_INTERNAL_EMAIL || "lltouch@outlook.com"
).trim();

const ACADEMY_NOTIFICATION_MAX_ATTEMPTS = 3;
const ACADEMY_NOTIFICATION_BATCH_SIZE = 25;

const ACADEMY_AVAILABLE_DATES_CACHE_MS = 30 * 1000;
const ACADEMY_AVAILABLE_DATES_MAX_API_CALLS = 16;
const academyAvailableDatesCache = new Map();

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
  // Checkout must never fail only because the customer database is unavailable.
  // When Supabase is down, use a zero-balance customer and create Stripe checkout
  // normally; VIP/cashback/first-purchase discounts are simply not applied.
  customer = customer || buildFallbackCustomer("");

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
// LL BROWS ACADEMY - GOOGLE CALENDAR HELPERS
// ==============================

function isGoogleCalendarConfigured() {
  return Boolean(
    GOOGLE_SERVICE_ACCOUNT_EMAIL &&
    GOOGLE_PRIVATE_KEY &&
    GOOGLE_CALENDAR_ID
  );
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function getGoogleCalendarAccessToken() {
  if (!isGoogleCalendarConfigured()) {
    throw new Error(
      "Google Calendar credentials are missing in Render environment variables."
    );
  }

  const now = Date.now();

  if (
    googleAccessTokenCache.accessToken &&
    googleAccessTokenCache.expiresAt &&
    now < googleAccessTokenCache.expiresAt - 60 * 1000
  ) {
    return googleAccessTokenCache.accessToken;
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 3600;

  const header = {
    alg: "RS256",
    typ: "JWT"
  };

  const claim = {
    iss: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: "https://www.googleapis.com/auth/calendar.events",
    aud: "https://oauth2.googleapis.com/token",
    iat: issuedAt,
    exp: expiresAt
  };

  const unsignedToken =
    `${base64UrlJson(header)}.${base64UrlJson(claim)}`;

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();

  const signature = signer
    .sign(GOOGLE_PRIVATE_KEY)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const assertion = `${unsignedToken}.${signature}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    }).toString()
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data?.access_token) {
    console.error("Google OAuth error:", {
      status: response.status,
      error: data?.error,
      error_description: data?.error_description
    });

    throw new Error(
      data?.error_description ||
      data?.error ||
      "Could not generate Google Calendar access token."
    );
  }

  const tokenExpiresIn = Number(data.expires_in || 3600);

  googleAccessTokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + tokenExpiresIn * 1000
  };

  return googleAccessTokenCache.accessToken;
}

async function googleCalendarRequest(path, options = {}) {
  const accessToken = await getGoogleCalendarAccessToken();

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3${path}`,
    {
      method: options.method || "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error("Google Calendar API error:", {
      path,
      status: response.status,
      error: data?.error
    });

    const error = new Error(
      data?.error?.message ||
      `Google Calendar API request failed (${response.status}).`
    );

    error.status = response.status;
    error.google = data;
    throw error;
  }

  return data;
}

function normalizeAcademyDateValue(value, fallbackDate = null) {
  const raw = String(value || "").trim();

  if (!raw) return fallbackDate;

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  const usMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    return `${usMatch[3]}-${String(usMatch[1]).padStart(2, "0")}-${String(usMatch[2]).padStart(2, "0")}`;
  }

  return fallbackDate;
}

function normalizeAcademyAvailability(availability, fallbackDate) {
  return (availability?.data || []).flatMap((day) => {
    const normalizedDate = normalizeAcademyDateValue(
      day.appointmentDate,
      fallbackDate
    );

    return (day.timeSlot || []).map((time) => ({
      date: normalizedDate,
      time,
      professional: "Ludimilla Leite",
      serviceProviderId: VAGARO_LUDIMILLA_PROVIDER_ID,
      serviceId: VAGARO_ACADEMY_SERVICE_ID,
      serviceTitle: VAGARO_ACADEMY_SERVICE_TITLE,
      durationMinutes: VAGARO_ACADEMY_DURATION_MINUTES
    }));
  });
}

function academyAddDaysISO(date, days) {
  const normalized = formatDateOnly(date);
  if (!normalized) return null;

  const [year, month, day] = normalized.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + Number(days || 0));

  return [
    value.getUTCFullYear(),
    String(value.getUTCMonth() + 1).padStart(2, "0"),
    String(value.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function academyEasternTodayISO() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: GOOGLE_CALENDAR_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    })
      .formatToParts(new Date())
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function academyGroupSlotsByDate(slots, minDate, maxDate) {
  const groups = new Map();

  for (const slot of slots || []) {
    const date = normalizeAcademyDateValue(slot?.date, null);
    const time = cleanLeadField(slot?.time, 80);

    if (!date || !time) continue;
    if (date < minDate || date > maxDate) continue;

    if (!groups.has(date)) {
      groups.set(date, []);
    }

    const existing = groups.get(date);

    if (!existing.some((item) => item.time === time)) {
      existing.push({
        ...slot,
        date,
        time
      });
    }
  }

  for (const [, items] of groups) {
    items.sort((a, b) => {
      const timeA = normalizeAcademyTime(a.time) || a.time;
      const timeB = normalizeAcademyTime(b.time) || b.time;
      return String(timeA).localeCompare(String(timeB));
    });
  }

  return groups;
}

function academyGoogleEventInterval(event) {
  if (!event || event.status === "cancelled") return null;
  if (event.transparency === "transparent") return null;

  try {
    let start = null;
    let end = null;

    if (event.start?.dateTime) {
      start = new Date(event.start.dateTime);
    } else if (event.start?.date) {
      start = zonedAcademyDateToUtc(
        event.start.date,
        "00:00",
        GOOGLE_CALENDAR_TIMEZONE
      );
    }

    if (event.end?.dateTime) {
      end = new Date(event.end.dateTime);
    } else if (event.end?.date) {
      end = zonedAcademyDateToUtc(
        event.end.date,
        "00:00",
        GOOGLE_CALENDAR_TIMEZONE
      );
    }

    if (
      !start ||
      !end ||
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime())
    ) {
      return null;
    }

    return {
      id: event.id || null,
      start,
      end
    };
  } catch (err) {
    console.error("Academy Google event interval parse failed:", err);
    return null;
  }
}

function isAcademyFunnelGoogleEvent(event) {
  return String(
    event?.extendedProperties?.private?.llBrowsAcademy || ""
  ).trim() === "1";
}

function isVagaroSyncedGoogleEvent(event) {
  // Events created by our own Academy funnel must continue blocking time,
  // even if a later sync adds other metadata.
  if (isAcademyFunnelGoogleEvent(event)) {
    return false;
  }

  const searchable = [
    event?.description,
    event?.location,
    event?.source?.url,
    event?.htmlLink
  ]
    .filter(Boolean)
    .map((value) => String(value))
    .join("\n");

  // Vagaro -> Google imported events include a Vagaro googlecalendar link.
  // Vagaro is already the authoritative availability source, so counting
  // these imported mirror events again would double-block the same schedule.
  return /vagaro\.com\/merchants\/googlecalendar/i.test(searchable);
}

async function getAcademyGoogleBusyEventsForRange(startDate, endDate) {
  if (!isGoogleCalendarConfigured()) {
    throw new Error("Google Calendar is not configured.");
  }

  const dayAfterEnd = academyAddDaysISO(endDate, 1);

  const rangeStart = zonedAcademyDateToUtc(
    startDate,
    "00:00",
    GOOGLE_CALENDAR_TIMEZONE
  );

  const rangeEnd = zonedAcademyDateToUtc(
    dayAfterEnd,
    "00:00",
    GOOGLE_CALENDAR_TIMEZONE
  );

  const encodedCalendarId = encodeURIComponent(GOOGLE_CALENDAR_ID);
  const events = [];
  let pageToken = "";

  do {
    const query = new URLSearchParams({
      timeMin: rangeStart.toISOString(),
      timeMax: rangeEnd.toISOString(),
      singleEvents: "true",
      showDeleted: "false",
      orderBy: "startTime",
      maxResults: "2500"
    });

    if (pageToken) {
      query.set("pageToken", pageToken);
    }

    const data = await googleCalendarRequest(
      `/calendars/${encodedCalendarId}/events?${query.toString()}`
    );

    for (const event of Array.isArray(data?.items) ? data.items : []) {
      if (isVagaroSyncedGoogleEvent(event)) {
        continue;
      }

      const interval = academyGoogleEventInterval(event);
      if (interval) events.push(interval);
    }

    pageToken = String(data?.nextPageToken || "");
  } while (pageToken);

  return events;
}

function academySlotInterval(slot) {
  const date = normalizeAcademyDateValue(slot?.date, null);
  const time = normalizeAcademyTime(slot?.time);

  if (!date || !time) return null;

  const endWallClock = addAcademyMinutes(
    date,
    time,
    VAGARO_ACADEMY_DURATION_MINUTES
  );

  if (!endWallClock) return null;

  const start = zonedAcademyDateToUtc(
    date,
    time,
    GOOGLE_CALENDAR_TIMEZONE
  );

  const end = zonedAcademyDateToUtc(
    endWallClock.date,
    endWallClock.time,
    GOOGLE_CALENDAR_TIMEZONE
  );

  return {
    start,
    end
  };
}

function academySlotConflictsWithGoogle(slot, busyEvents) {
  const interval = academySlotInterval(slot);
  if (!interval) return true;

  return (busyEvents || []).some(
    (event) =>
      interval.start < event.end &&
      interval.end > event.start
  );
}

function filterAcademySlotsAgainstGoogle(slots, busyEvents) {
  return (slots || []).filter(
    (slot) => !academySlotConflictsWithGoogle(slot, busyEvents)
  );
}

function clearAcademyAvailableDatesCache() {
  academyAvailableDatesCache.clear();
}

async function discoverAcademyAvailableDates({
  startDate,
  maxDays = 30,
  maxDates = 8
}) {
  const normalizedStart = formatDateOnly(startDate) || academyEasternTodayISO();
  const days = Math.max(1, Math.min(Number(maxDays) || 30, 45));
  const wantedDates = Math.max(1, Math.min(Number(maxDates) || 8, 12));
  const endDate = academyAddDaysISO(normalizedStart, days - 1);

  // Vagaro is the scheduling source, but Google Calendar is also a BUSY
  // source because Google -> Vagaro sync can have propagation delay.
  // We therefore remove Google-busy intervals before showing any slot.
  const googleBusyEvents = await getAcademyGoogleBusyEventsForRange(
    normalizedStart,
    endDate
  );

  const cacheKey = `${normalizedStart}|${days}|${wantedDates}`;
  const cached = academyAvailableDatesCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return {
      ...cached.value,
      cached: true
    };
  }

  const found = new Map();
  let cursor = normalizedStart;
  let apiCalls = 0;
  let lastRequestedDate = normalizedStart;

  while (
    cursor &&
    cursor <= endDate &&
    found.size < wantedDates &&
    apiCalls < ACADEMY_AVAILABLE_DATES_MAX_API_CALLS
  ) {
    lastRequestedDate = cursor;
    apiCalls += 1;

    let availability;

    try {
      availability = await searchVagaroAvailability({
        date: cursor,
        serviceId: VAGARO_ACADEMY_SERVICE_ID,
        addOnIds: []
      });
    } catch (err) {
      console.error("Academy available-date discovery request failed:", {
        date: cursor,
        error: err?.message || String(err)
      });

      cursor = academyAddDaysISO(cursor, 1);
      continue;
    }

    const normalizedSlots = normalizeAcademyAvailability(
      availability,
      cursor
    );

    const groups = academyGroupSlotsByDate(
      normalizedSlots,
      cursor,
      endDate
    );

    // Remove every slot that overlaps any BUSY Google Calendar event.
    for (const [date, slots] of groups.entries()) {
      const filtered = filterAcademySlotsAgainstGoogle(
        slots,
        googleBusyEvents
      );

      if (filtered.length) {
        groups.set(date, filtered);
      } else {
        groups.delete(date);
      }
    }

    const groupDates = [...groups.keys()].sort();

    if (groupDates.length === 0) {
      cursor = academyAddDaysISO(cursor, 1);
      continue;
    }

    for (const date of groupDates) {
      const incoming = Array.isArray(groups.get(date))
        ? groups.get(date)
        : [];

      if (incoming.length) {
        const existing = Array.isArray(found.get(date))
          ? found.get(date)
          : [];

        const merged = [...existing];

        for (const slot of incoming) {
          const normalizedTime = normalizeAcademyTime(slot?.time);

          if (
            normalizedTime &&
            !merged.some(
              (item) =>
                normalizeAcademyTime(item?.time) === normalizedTime
            )
          ) {
            merged.push(slot);
          }
        }

        merged.sort((a, b) =>
          String(normalizeAcademyTime(a?.time) || "").localeCompare(
            String(normalizeAcademyTime(b?.time) || "")
          )
        );

        found.set(date, merged);
      }

      if (found.size >= wantedDates) break;
    }

    // Vagaro may return the next available date instead of the exact
    // requested day. Jump to the day after the latest returned date
    // so we do not need to query every empty day one by one.
    const latestReturnedDate = groupDates[groupDates.length - 1];

    if (latestReturnedDate && latestReturnedDate >= cursor) {
      cursor = academyAddDaysISO(latestReturnedDate, 1);
    } else {
      cursor = academyAddDaysISO(cursor, 1);
    }
  }

  const dates = [...found.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, wantedDates)
    .map(([date, slots]) => ({
      date,
      slots
    }));

  const result = {
    startDate: normalizedStart,
    endDate,
    maxDays: days,
    maxDates: wantedDates,
    dates,
    availableDateCount: dates.length,
    apiCalls,
    googleBusyEventsChecked: googleBusyEvents.length,
    searchedThrough: lastRequestedDate,
    cached: false
  };

  academyAvailableDatesCache.set(cacheKey, {
    expiresAt: Date.now() + ACADEMY_AVAILABLE_DATES_CACHE_MS,
    value: result
  });

  return result;
}

function academyTruthy(value) {
  if (value === true) return true;
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function normalizeAcademyTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  // Accepts 2:30 PM, 02:30 PM, 14:30, 14:30:00 and ISO-like timestamps.
  const isoTimeMatch = raw.match(/T(\d{2}):(\d{2})/);
  if (isoTimeMatch) {
    return `${isoTimeMatch[1]}:${isoTimeMatch[2]}`;
  }

  const match = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = String(match[3] || "").toUpperCase();

  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return null;
  }

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "AM") {
      if (hour === 12) hour = 0;
    } else if (meridiem === "PM") {
      if (hour !== 12) hour += 12;
    }
  } else if (hour < 0 || hour > 23) {
    return null;
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function academyDisplayTime(hhmm) {
  const normalized = normalizeAcademyTime(hhmm);
  if (!normalized) return String(hhmm || "");

  const [hourText, minuteText] = normalized.split(":");
  const hour = Number(hourText);
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;

  return `${displayHour}:${minuteText} ${suffix}`;
}

function addAcademyMinutes(date, hhmm, minutes) {
  const [year, month, day] = String(date).split("-").map(Number);
  const normalized = normalizeAcademyTime(hhmm);
  if (!year || !month || !day || !normalized) return null;

  const [hour, minute] = normalized.split(":").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  value.setUTCMinutes(value.getUTCMinutes() + Number(minutes || 0));

  return {
    date: `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`,
    time: `${String(value.getUTCHours()).padStart(2, "0")}:${String(value.getUTCMinutes()).padStart(2, "0")}`
  };
}

function zonedAcademyDateToUtc(date, hhmm, timeZone = GOOGLE_CALENDAR_TIMEZONE) {
  const [year, month, day] = String(date).split("-").map(Number);
  const normalized = normalizeAcademyTime(hhmm);

  if (!year || !month || !day || !normalized) {
    throw new Error("Invalid Academy date/time.");
  }

  const [hour, minute] = normalized.split(":").map(Number);
  const targetWallClock = Date.UTC(year, month - 1, day, hour, minute, 0);

  let guess = targetWallClock;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  for (let i = 0; i < 3; i += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(guess))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value])
    );

    const observedWallClock = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );

    const offset = observedWallClock - guess;
    const nextGuess = targetWallClock - offset;

    if (Math.abs(nextGuess - guess) < 1000) {
      guess = nextGuess;
      break;
    }

    guess = nextGuess;
  }

  return new Date(guess);
}

function academySlotEventId(date, hhmm) {
  const normalized = normalizeAcademyTime(hhmm) || String(hhmm || "");
  const digest = crypto
    .createHash("sha256")
    .update(`llbrows-academy|${VAGARO_LUDIMILLA_PROVIDER_ID}|${date}|${normalized}`)
    .digest("hex")
    .slice(0, 48);

  // Google custom event IDs accept base32hex-compatible lowercase chars;
  // 0-9 and a-f are valid, so the SHA-256 hex digest is safe here.
  return `llba${digest}`;
}

function academyBookingFingerprint(email, date, hhmm) {
  return crypto
    .createHash("sha256")
    .update(`${String(email || "").trim().toLowerCase()}|${date}|${normalizeAcademyTime(hhmm) || hhmm}`)
    .digest("hex");
}

async function getAcademyGoogleConflicts(startUtc, endUtc) {
  const encodedCalendarId = encodeURIComponent(GOOGLE_CALENDAR_ID);
  const query = new URLSearchParams({
    timeMin: startUtc.toISOString(),
    timeMax: endUtc.toISOString(),
    singleEvents: "true",
    showDeleted: "false",
    orderBy: "startTime",
    maxResults: "50"
  });

  const data = await googleCalendarRequest(
    `/calendars/${encodedCalendarId}/events?${query.toString()}`
  );

  return (Array.isArray(data?.items) ? data.items : []).filter((event) => {
    if (!event || event.status === "cancelled") return false;
    if (event.transparency === "transparent") return false;
    return true;
  });
}

function extractAcademyCandidate(body = {}) {
  const candidate = body.candidate && typeof body.candidate === "object"
    ? body.candidate
    : {};

  return {
    fullName: cleanLeadField(
      candidate.fullName ||
      candidate.full_name ||
      body.fullName ||
      body.full_name ||
      body.name,
      120
    ),
    email: cleanLeadField(candidate.email || body.email, 180).toLowerCase(),
    phone: cleanLeadField(candidate.phone || body.phone, 60)
  };
}

function extractAcademyAppointment(body = {}) {
  const appointment = body.appointment && typeof body.appointment === "object"
    ? body.appointment
    : {};

  return {
    date: formatDateOnly(appointment.date || body.date),
    timeRaw: cleanLeadField(
      appointment.time ||
      appointment.startTime ||
      appointment.start_time ||
      body.time ||
      body.startTime ||
      body.start_time,
      80
    )
  };
}

function extractAcademyTerms(body = {}) {
  const terms = body.terms && typeof body.terms === "object" ? body.terms : {};
  const agreements = body.agreements && typeof body.agreements === "object"
    ? body.agreements
    : {};

  return {
    attend: academyTruthy(terms.attend ?? agreements.attend ?? body.attend),
    quietSpace: academyTruthy(
      terms.quietSpace ??
      terms.quiet_space ??
      agreements.quietSpace ??
      agreements.quiet_space ??
      body.quietSpace ??
      body.quiet_space
    ),
    reminders: academyTruthy(
      terms.reminders ??
      agreements.reminders ??
      body.reminders
    )
  };
}

function academyArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanLeadField(item, 220)).filter(Boolean);
  }

  const single = cleanLeadField(value, 220);
  return single ? [single] : [];
}

function academyUuid(value) {
  const str = String(value || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str)
    ? str
    : null;
}

function normalizeAcademyApplication(body = {}) {
  return {
    fullName: cleanLeadField(body.full_name || body.fullName || body.name, 120),
    phone: cleanLeadField(body.phone, 60),
    email: cleanLeadField(body.email, 180).toLowerCase(),
    instagram: cleanLeadField(body.instagram, 120),
    city: cleanLeadField(body.city, 120),
    state: cleanLeadField(body.state, 120),
    stage: cleanLeadField(body.stage, 220),
    interest: cleanLeadField(body.interest, 120),
    previousTraining: cleanLeadField(
      body.previous_training || body.previousTraining,
      220
    ),
    experience: cleanLeadField(body.experience, 3000),
    goals: academyArray(body.goals),
    challenges: academyArray(body.challenges),
    timeline: cleanLeadField(body.timeline, 220),
    investmentReadiness: cleanLeadField(
      body.investment_readiness || body.investmentReadiness,
      220
    ),
    notes: cleanLeadField(body.notes, 3000),
    attendanceAgreement: academyTruthy(
      body.attendance_agreement || body.attendanceAgreement
    ),
    smsReminders: academyTruthy(
      body.sms_reminders || body.smsReminders
    ),
    marketingOptin: academyTruthy(
      body.marketing_optin || body.marketingOptin
    ),
    source: cleanLeadField(
      body.source || "LL Brows Academy Application",
      160
    )
  };
}

function isAcademyZoomConfigured() {
  return Boolean(
    ZOOM_ACCOUNT_ID &&
    ZOOM_CLIENT_ID &&
    ZOOM_CLIENT_SECRET &&
    ZOOM_HOST_EMAIL
  );
}

async function getAcademyZoomAccessToken() {
  if (!isAcademyZoomConfigured()) {
    throw new Error("Zoom credentials are missing in Render environment variables.");
  }

  const now = Date.now();

  if (
    zoomAccessTokenCache.accessToken &&
    zoomAccessTokenCache.expiresAt &&
    now < zoomAccessTokenCache.expiresAt - 60 * 1000
  ) {
    return zoomAccessTokenCache.accessToken;
  }

  const basic = Buffer.from(
    `${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`
  ).toString("base64");

  const params = new URLSearchParams({
    grant_type: "account_credentials",
    account_id: ZOOM_ACCOUNT_ID
  });

  const response = await fetch(
    `https://zoom.us/oauth/token?${params.toString()}`,
    {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded"
      }
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data?.access_token) {
    console.error("Zoom OAuth error:", {
      status: response.status,
      reason: data?.reason,
      error: data?.error
    });

    throw new Error(
      data?.reason ||
      data?.error ||
      `Could not generate Zoom access token (${response.status}).`
    );
  }

  const expiresIn = Number(data.expires_in || 3600);

  zoomAccessTokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + expiresIn * 1000
  };

  return zoomAccessTokenCache.accessToken;
}

async function academyZoomRequest(path, options = {}) {
  const accessToken = await getAcademyZoomAccessToken();

  const response = await fetch(
    `https://api.zoom.us/v2${path}`,
    {
      method: options.method || "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error("Zoom API error:", {
      path,
      status: response.status,
      code: data?.code,
      message: data?.message
    });

    const error = new Error(
      data?.message ||
      `Zoom API request failed (${response.status}).`
    );

    error.status = response.status;
    error.zoom = data;
    throw error;
  }

  return data;
}

async function createAcademyZoomMeeting(booking) {
  const fullName = cleanLeadField(booking?.full_name, 120) || "Candidate";
  const timezone = cleanLeadField(
    booking?.timezone || GOOGLE_CALENDAR_TIMEZONE,
    100
  ) || GOOGLE_CALENDAR_TIMEZONE;

  const meeting = await academyZoomRequest(
    `/users/${encodeURIComponent(ZOOM_HOST_EMAIL)}/meetings`,
    {
      method: "POST",
      body: {
        topic: `LL Brows Academy - Private PMU Career & Business Audit - ${fullName}`.slice(0, 200),
        type: 2,
        start_time: (
          booking?.appointment_date &&
          normalizeAcademyTime(booking?.appointment_time)
        )
          ? `${booking.appointment_date}T${normalizeAcademyTime(booking.appointment_time)}:00`
          : new Intl.DateTimeFormat("sv-SE", {
              timeZone: timezone,
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: false
            }).format(new Date(booking.starts_at)).replace(" ", "T"),
        duration: VAGARO_ACADEMY_DURATION_MINUTES,
        timezone,
        agenda: "Private PMU Career & Business Audit with Ludimilla Leite"
      }
    }
  );

  if (!meeting?.id || !meeting?.join_url) {
    throw new Error("Zoom did not return a meeting ID and participant join URL.");
  }

  return {
    meetingId: String(meeting.id),
    joinUrl: String(meeting.join_url),
    createdAt: new Date().toISOString()
  };
}

async function updateAcademyGoogleEventWithZoom(booking) {
  if (!booking?.google_event_id || !booking?.zoom_join_url) return;

  const encodedCalendarId = encodeURIComponent(GOOGLE_CALENDAR_ID);
  const eventId = encodeURIComponent(booking.google_event_id);

  const description = [
    "Private PMU Career & Business Audit",
    `Candidate: ${booking.full_name || ""}`,
    `Email: ${booking.email || ""}`,
    `Phone: ${booking.phone || ""}`,
    `Join Zoom Meeting: ${booking.zoom_join_url}`,
    "Source: LL Brows Academy funnel"
  ].join("\\n");

  await googleCalendarRequest(
    `/calendars/${encodedCalendarId}/events/${eventId}?sendUpdates=none`,
    {
      method: "PATCH",
      body: {
        location: "Zoom",
        description
      }
    }
  );
}

async function ensureAcademyZoomMeeting(booking) {
  if (!booking?.id) {
    throw new Error("Academy booking ID is required before creating Zoom meeting.");
  }

  if (booking.zoom_meeting_id && booking.zoom_join_url) {
    return booking;
  }

  if (!isAcademyZoomConfigured()) {
    throw new Error("Zoom is not configured for LL Brows Academy.");
  }

  try {
    const zoom = await createAcademyZoomMeeting(booking);

    const { data, error } = await academySupabase
      .from("academy_bookings")
      .update({
        zoom_meeting_id: zoom.meetingId,
        zoom_join_url: zoom.joinUrl,
        zoom_created_at: zoom.createdAt,
        zoom_last_error: null,
        updated_at: new Date().toISOString()
      })
      .eq("id", booking.id)
      .select(
        "id, application_id, google_event_id, booking_fingerprint, full_name, email, phone, appointment_date, appointment_time, starts_at, ends_at, timezone, service, professional, reminders_consent, status, zoom_meeting_id, zoom_join_url, zoom_created_at, zoom_last_error, created_at, updated_at"
      )
      .single();

    if (error || !data) {
      throw new Error(
        error?.message ||
        "Zoom meeting was created but could not be saved to the Academy booking."
      );
    }

    try {
      await updateAcademyGoogleEventWithZoom(data);
    } catch (calendarError) {
      console.error(
        "Academy Zoom meeting saved, but Google Calendar event could not be updated with Zoom link:",
        calendarError
      );
    }

    return data;
  } catch (err) {
    try {
      await academySupabase
        .from("academy_bookings")
        .update({
          zoom_last_error: String(err?.message || err).slice(0, 1200),
          updated_at: new Date().toISOString()
        })
        .eq("id", booking.id);
    } catch (saveError) {
      console.error("Could not save Academy Zoom error:", saveError);
    }

    throw err;
  }
}

function isAcademyEmailConfigured() {
  return Boolean(RESEND_API_KEY && ACADEMY_EMAIL_FROM);
}

function isAcademySmsConfigured() {
  return Boolean(
    TWILIO_ACCOUNT_SID &&
    TWILIO_AUTH_TOKEN &&
    (TWILIO_FROM_NUMBER || TWILIO_MESSAGING_SERVICE_SID)
  );
}

function isAcademyInternalEmailConfigured() {
  return Boolean(WEB3FORMS_ACCESS_KEY);
}

function academyDisplayArray(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean).join(", ");
  }

  return String(value || "").trim();
}

async function getAcademyApplicationForInternalEmail(booking) {
  try {
    let query = academySupabase
      .from("academy_applications")
      .select(
        "id, full_name, phone, email, instagram, city, state, stage, interest, previous_training, experience, goals, challenges, timeline, investment_readiness, notes, attendance_agreement, sms_reminders, marketing_optin, source, status, created_at"
      );

    if (booking?.application_id) {
      const { data, error } = await query
        .eq("id", booking.application_id)
        .maybeSingle();

      if (!error && data) return data;
    }

    const email = String(booking?.email || "").trim().toLowerCase();

    if (!email) return null;

    const { data, error } = await academySupabase
      .from("academy_applications")
      .select(
        "id, full_name, phone, email, instagram, city, state, stage, interest, previous_training, experience, goals, challenges, timeline, investment_readiness, notes, attendance_agreement, sms_reminders, marketing_optin, source, status, created_at"
      )
      .eq("email", email)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("Academy internal email application lookup failed:", error);
      return null;
    }

    return data || null;
  } catch (err) {
    console.error("Academy internal email application lookup exception:", err);
    return null;
  }
}

async function sendAcademyInternalWeb3Forms({ booking }) {
  if (!isAcademyInternalEmailConfigured()) {
    throw new Error("Web3Forms internal email is not configured.");
  }

  const application = await getAcademyApplicationForInternalEmail(booking);
  const when = formatAcademyStart(booking.starts_at);

  const goals = academyDisplayArray(application?.goals);
  const challenges = academyDisplayArray(application?.challenges);

  const message = [
    "NEW LL BROWS ACADEMY APPLICATION + CONFIRMED BOOKING",
    "",
    "STUDENT",
    `Name: ${booking.full_name || application?.full_name || ""}`,
    `Email: ${booking.email || application?.email || ""}`,
    `Phone: ${booking.phone || application?.phone || ""}`,
    `Instagram: ${application?.instagram || ""}`,
    `City / State: ${[application?.city, application?.state].filter(Boolean).join(", ")}`,
    "",
    "APPLICATION",
    `Current stage: ${application?.stage || ""}`,
    `Interest: ${application?.interest || ""}`,
    `Previous PMU training: ${application?.previous_training || ""}`,
    `Experience: ${application?.experience || ""}`,
    `Goals: ${goals}`,
    `Challenges: ${challenges}`,
    `Timeline: ${application?.timeline || ""}`,
    `Investment readiness: ${application?.investment_readiness || ""}`,
    `Additional notes: ${application?.notes || ""}`,
    `SMS reminders consent (application): ${application?.sms_reminders ? "Yes" : "No"}`,
    `Marketing opt-in: ${application?.marketing_optin ? "Yes" : "No"}`,
    "",
    "CONFIRMED SESSION",
    `Date / Time: ${when}`,
    `Duration: 45 minutes`,
    `Professional: ${booking.professional || "Ludimilla Leite"}`,
    `Service: ${booking.service || VAGARO_ACADEMY_SERVICE_TITLE}`,
    `Reminder consent (confirmation): ${booking.reminders_consent ? "Yes" : "No"}`,
    "",
    "REFERENCES",
    `Application ID: ${application?.id || booking.application_id || ""}`,
    `Booking ID: ${booking.id || ""}`,
    `Google Event ID: ${booking.google_event_id || ""}`,
    "",
    "Source: LL Brows Academy funnel"
  ].join("\n");

  const payload = {
    access_key: WEB3FORMS_ACCESS_KEY,
    subject: `New LL Brows Academy Booking — ${booking.full_name || "Candidate"}`,
    from_name: "LL Brows Academy Funnel",
    name: booking.full_name || application?.full_name || "LL Brows Academy Candidate",
    email: booking.email || application?.email || ACADEMY_INTERNAL_EMAIL,
    phone: booking.phone || application?.phone || "",
    instagram: application?.instagram || "",
    city_state: [application?.city, application?.state].filter(Boolean).join(", "),
    current_stage: application?.stage || "",
    interest: application?.interest || "",
    previous_training: application?.previous_training || "",
    goals,
    challenges,
    timeline: application?.timeline || "",
    investment_readiness: application?.investment_readiness || "",
    confirmed_session: when,
    professional: booking.professional || "Ludimilla Leite",
    application_id: application?.id || booking.application_id || "",
    booking_id: booking.id || "",
    message
  };

  const response = await fetch("https://api.web3forms.com/submit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data?.success !== true) {
    throw new Error(
      data?.message ||
      `Web3Forms request failed (${response.status}).`
    );
  }

  return {
    provider: "web3forms",
    id: data?.data?.id || data?.id || null
  };
}

function normalizeAcademyPhoneE164(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  if (/^\+[1-9]\d{7,14}$/.test(raw.replace(/[^\d+]/g, ""))) {
    return raw.replace(/[^\d+]/g, "");
  }

  const digits = raw.replace(/\D/g, "");

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  return null;
}

function escapeAcademyHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatAcademyStart(startIso) {
  const date = new Date(startIso);

  return new Intl.DateTimeFormat("en-US", {
    timeZone: GOOGLE_CALENDAR_TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(date);
}

function academyNotificationCopy(notification) {
  const booking = notification.academy_bookings || notification.booking || {};
  const fullName = cleanLeadField(booking.full_name, 120);
  const firstName = fullName.split(/\s+/).filter(Boolean)[0] || "there";
  const when = formatAcademyStart(booking.starts_at);
  const safeWhen = escapeAcademyHtml(when);
  const safeFirstName = escapeAcademyHtml(firstName);
  const preCallUrl = escapeAcademyHtml(ACADEMY_PRECALL_URL);

  if (notification.kind === "reminder_24h") {
    return {
      subject: "Your LL Brows Academy session is tomorrow",
      text:
        `Hi ${firstName}, this is a reminder that your private LL Brows Academy session with Ludimilla Leite is scheduled for ${when}. ` +
        `Please set aside 45 minutes in a quiet place. Prepare here: ${ACADEMY_PRECALL_URL}`,
      html:
        `<p>Hi ${safeFirstName},</p>` +
        `<p>Your private LL Brows Academy session with Ludimilla Leite is <strong>tomorrow</strong>.</p>` +
        `<p><strong>${safeWhen}</strong></p>` +
        `<p>Please set aside 45 minutes in a quiet place where you can focus.</p>` +
        `<p><a href="${preCallUrl}">Review your pre-call preparation</a></p>` +
        `<p>LL Brows Academy</p>`,
      sms:
        `LL Brows Academy reminder: your private session with Ludimilla is tomorrow, ${when}. Prepare: ${ACADEMY_PRECALL_URL}`
    };
  }

  if (notification.kind === "reminder_2h") {
    const zoomJoinUrl = cleanLeadField(booking.zoom_join_url, 2000);
    const safeZoomJoinUrl = escapeAcademyHtml(zoomJoinUrl);

    return {
      subject: "Your LL Brows Academy session starts in about 2 hours",
      text:
        `Hi ${firstName}, your private LL Brows Academy session with Ludimilla Leite starts in about 2 hours. ` +
        `Scheduled time: ${when}. Join Zoom: ${zoomJoinUrl}`,
      html:
        `<p>Hi ${safeFirstName},</p>` +
        `<p>Your private LL Brows Academy session with Ludimilla Leite starts in about <strong>2 hours</strong>.</p>` +
        `<p><strong>${safeWhen}</strong></p>` +
        `<p><a href="${safeZoomJoinUrl}"><strong>Join your Zoom session</strong></a></p>` +
        `<p>Please join from a quiet place where you can focus.</p>` +
        `<p>LL Brows Academy</p>`,
      sms:
        `LL Brows Academy reminder: your private session with Ludimilla starts in about 2 hours. ${when}. Join Zoom: ${zoomJoinUrl} Reply STOP to opt out or HELP for help.`
    };
  }

  return {
    subject: "Your LL Brows Academy private session is confirmed",
    text:
      `Hi ${firstName}, your private PMU Career & Business Audit with Ludimilla Leite is confirmed for ${when}. ` +
      `The session is approximately 45 minutes. Prepare before the call: ${ACADEMY_PRECALL_URL}`,
    html:
      `<p>Hi ${safeFirstName},</p>` +
      `<p>Your <strong>Private PMU Career &amp; Business Audit</strong> with Ludimilla Leite is confirmed.</p>` +
      `<p><strong>${safeWhen}</strong></p>` +
      `<p>Duration: approximately 45 minutes.</p>` +
      `<p>Before the call, please complete the short preparation here:</p>` +
      `<p><a href="${preCallUrl}">${preCallUrl}</a></p>` +
      `<p>We look forward to learning more about your goals.</p>` +
      `<p>LL Brows Academy</p>`,
    sms:
      `LL Brows Academy: your private session with Ludimilla is confirmed for ${when}. Prepare here: ${ACADEMY_PRECALL_URL}`
  };
}

async function sendAcademyEmail({
  to,
  subject,
  text,
  html,
  idempotencyKey
}) {
  if (!isAcademyEmailConfigured()) {
    throw new Error("Resend email is not configured.");
  }

  const payload = {
    from: ACADEMY_EMAIL_FROM,
    to: [to],
    subject,
    text,
    html
  };

  if (ACADEMY_REPLY_TO_EMAIL) {
    payload.reply_to = ACADEMY_REPLY_TO_EMAIL;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${RESEND_API_KEY}`,
      "content-type": "application/json",
      "Idempotency-Key": String(idempotencyKey || "").slice(0, 256)
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error?.message ||
      `Resend request failed (${response.status}).`;
    throw new Error(message);
  }

  return {
    provider: "resend",
    id: data?.id || null
  };
}

async function sendAcademySms({
  to,
  body
}) {
  if (!isAcademySmsConfigured()) {
    throw new Error("Twilio SMS is not configured.");
  }

  const normalizedTo = normalizeAcademyPhoneE164(to);

  if (!normalizedTo) {
    throw new Error("Candidate phone number is not valid for SMS.");
  }

  const form = new URLSearchParams({
    To: normalizedTo,
    Body: body
  });

  if (TWILIO_MESSAGING_SERVICE_SID) {
    form.set("MessagingServiceSid", TWILIO_MESSAGING_SERVICE_SID);
  } else {
    form.set("From", TWILIO_FROM_NUMBER);
  }

  const basic = Buffer.from(
    `${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`
  ).toString("base64");

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Messages.json`,
    {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.message ||
      `Twilio request failed (${response.status}).`
    );
  }

  return {
    provider: "twilio",
    id: data?.sid || null
  };
}

async function resolveAcademyApplicationId(email, suppliedId) {
  const validSuppliedId = academyUuid(suppliedId);
  if (validSuppliedId) return validSuppliedId;

  try {
    const { data, error } = await academySupabase
      .from("academy_applications")
      .select("id")
      .eq("email", String(email || "").trim().toLowerCase())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("Academy application lookup failed:", error);
      return null;
    }

    return data?.id || null;
  } catch (err) {
    console.error("Academy application lookup exception:", err);
    return null;
  }
}

async function persistAcademyBooking({
  applicationId,
  candidate,
  terms,
  appointment,
  selectedTime,
  startUtc,
  endUtc,
  eventId,
  bookingFingerprint
}) {
  const resolvedApplicationId = await resolveAcademyApplicationId(
    candidate.email,
    applicationId
  );

  const record = {
    application_id: resolvedApplicationId,
    google_event_id: eventId,
    booking_fingerprint: bookingFingerprint,
    full_name: candidate.fullName,
    email: candidate.email,
    phone: candidate.phone,
    appointment_date: appointment.date,
    appointment_time: selectedTime,
    starts_at: startUtc.toISOString(),
    ends_at: endUtc.toISOString(),
    timezone: GOOGLE_CALENDAR_TIMEZONE,
    service: VAGARO_ACADEMY_SERVICE_TITLE,
    professional: "Ludimilla Leite",
    reminders_consent: Boolean(terms.reminders),
    status: "confirmed",
    updated_at: new Date().toISOString()
  };

  const { data, error } = await academySupabase
    .from("academy_bookings")
    .upsert(record, { onConflict: "google_event_id" })
    .select(
      "id, application_id, google_event_id, booking_fingerprint, full_name, email, phone, appointment_date, appointment_time, starts_at, ends_at, timezone, service, professional, reminders_consent, status, zoom_meeting_id, zoom_join_url, zoom_created_at, zoom_last_error, created_at, updated_at"
    )
    .single();

  if (error || !data) {
    throw new Error(
      error?.message ||
      "Could not persist Academy booking."
    );
  }

  return data;
}

async function queueAcademyNotifications(booking) {
  const rows = [];
  const now = Date.now();
  const startsAtMs = new Date(booking.starts_at).getTime();
  const email = String(booking.email || "").trim().toLowerCase();
  const phone = normalizeAcademyPhoneE164(booking.phone);

  if (email) {
    rows.push({
      booking_id: booking.id,
      channel: "email",
      kind: "confirmation",
      recipient: email,
      scheduled_at: new Date(now).toISOString(),
      status: "pending"
    });
  }

  if (booking.reminders_consent && phone) {
    rows.push({
      booking_id: booking.id,
      channel: "sms",
      kind: "confirmation",
      recipient: phone,
      scheduled_at: new Date(now).toISOString(),
      status: "pending"
    });
  }

  if (booking.reminders_consent) {
    const reminderSchedule = [
      ["reminder_24h", 24 * 60 * 60 * 1000],
      ["reminder_2h", 2 * 60 * 60 * 1000]
    ];

    for (const [kind, beforeMs] of reminderSchedule) {
      const scheduledAtMs = startsAtMs - beforeMs;

      // Only create reminders that are still meaningfully in the future.
      if (scheduledAtMs <= now + 5 * 60 * 1000) continue;

      if (email) {
        rows.push({
          booking_id: booking.id,
          channel: "email",
          kind,
          recipient: email,
          scheduled_at: new Date(scheduledAtMs).toISOString(),
          status: "pending"
        });
      }

      if (phone) {
        rows.push({
          booking_id: booking.id,
          channel: "sms",
          kind,
          recipient: phone,
          scheduled_at: new Date(scheduledAtMs).toISOString(),
          status: "pending"
        });
      }
    }
  }

  if (!rows.length) {
    return {
      queued: 0
    };
  }

  const { error } = await academySupabase
    .from("academy_notifications")
    .upsert(rows, {
      onConflict: "booking_id,channel,kind",
      ignoreDuplicates: true
    });

  if (error) {
    throw new Error(
      error.message ||
      "Could not queue Academy notifications."
    );
  }

  return {
    queued: rows.length
  };
}

async function claimAcademyNotification(row) {
  const nextAttempts = Number(row.attempts || 0) + 1;

  const { data, error } = await academySupabase
    .from("academy_notifications")
    .update({
      status: "processing",
      attempts: nextAttempts,
      updated_at: new Date().toISOString()
    })
    .eq("id", row.id)
    .in("status", ["pending", "failed"])
    .select("id, attempts")
    .maybeSingle();

  if (error || !data) return null;

  return {
    ...row,
    attempts: Number(data.attempts || nextAttempts)
  };
}

async function processAcademyNotificationRow(row) {
  const claimed = await claimAcademyNotification(row);
  if (!claimed) {
    return {
      id: row.id,
      skipped: true
    };
  }

  try {
    let providerResult;

    if (claimed.kind === "reminder_2h") {
      const booking = claimed.academy_bookings || claimed.booking || {};

      if (!booking.zoom_join_url || !booking.zoom_meeting_id) {
        const bookingWithZoom = await ensureAcademyZoomMeeting(booking);
        claimed.academy_bookings = bookingWithZoom;
      }

      if (!claimed.academy_bookings?.zoom_join_url) {
        throw new Error(
          "The 2-hour reminder was not sent because the Zoom join URL is unavailable."
        );
      }
    }

    if (claimed.channel === "email") {
      const copy = academyNotificationCopy(claimed);

      providerResult = await sendAcademyEmail({
        to: claimed.recipient,
        subject: copy.subject,
        text: copy.text,
        html: copy.html,
        idempotencyKey:
          `academy/${claimed.booking_id}/${claimed.kind}/email`
      });
    } else if (claimed.channel === "sms") {
      const copy = academyNotificationCopy(claimed);

      providerResult = await sendAcademySms({
        to: claimed.recipient,
        body: copy.sms
      });
    } else if (claimed.channel === "internal") {
      throw new Error(
        "Internal Web3Forms delivery has moved to the browser confirmation page."
      );
    } else {
      throw new Error("Unsupported Academy notification channel.");
    }

    await academySupabase
      .from("academy_notifications")
      .update({
        status: "sent",
        provider_id: providerResult?.id || null,
        provider: providerResult?.provider || null,
        sent_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString()
      })
      .eq("id", claimed.id);

    return {
      id: claimed.id,
      sent: true,
      channel: claimed.channel,
      kind: claimed.kind,
      providerId: providerResult?.id || null
    };
  } catch (err) {
    const finalStatus =
      claimed.attempts >= ACADEMY_NOTIFICATION_MAX_ATTEMPTS
        ? "failed"
        : "failed";

    await academySupabase
      .from("academy_notifications")
      .update({
        status: finalStatus,
        last_error: String(err?.message || err).slice(0, 1200),
        updated_at: new Date().toISOString()
      })
      .eq("id", claimed.id);

    return {
      id: claimed.id,
      sent: false,
      channel: claimed.channel,
      kind: claimed.kind,
      error: String(err?.message || err)
    };
  }
}

async function processAcademyNotificationQueue({
  bookingId = null,
  confirmationOnly = false
} = {}) {
  const staleBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  // Recover notifications that were claimed by a process that died.
  await academySupabase
    .from("academy_notifications")
    .update({
      status: "failed",
      updated_at: new Date().toISOString()
    })
    .eq("status", "processing")
    .lt("updated_at", staleBefore);

  let query = academySupabase
    .from("academy_notifications")
    .select(`
      id,
      booking_id,
      channel,
      kind,
      recipient,
      scheduled_at,
      status,
      attempts,
      academy_bookings (
        id,
        application_id,
        google_event_id,
        full_name,
        email,
        phone,
        appointment_date,
        appointment_time,
        starts_at,
        ends_at,
        timezone,
        service,
        professional,
        reminders_consent,
        status,
        zoom_meeting_id,
        zoom_join_url,
        zoom_created_at,
        zoom_last_error
      )
    `)
    .in("status", ["pending", "failed"])
    .lt("attempts", ACADEMY_NOTIFICATION_MAX_ATTEMPTS)
    .lte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(ACADEMY_NOTIFICATION_BATCH_SIZE);

  if (bookingId) {
    query = query.eq("booking_id", bookingId);
  }

  if (confirmationOnly) {
    query = query.eq("kind", "confirmation");
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(
      error.message ||
      "Could not read Academy notification queue."
    );
  }

  const results = [];

  for (const row of data || []) {
    // Do not send reminders for cancelled/non-confirmed bookings.
    const booking = row.academy_bookings;

    if (!booking || booking.status !== "confirmed") {
      await academySupabase
        .from("academy_notifications")
        .update({
          status: "skipped",
          last_error: "Booking is not confirmed.",
          updated_at: new Date().toISOString()
        })
        .eq("id", row.id);

      results.push({
        id: row.id,
        skipped: true,
        reason: "booking_not_confirmed"
      });
      continue;
    }

    results.push(await processAcademyNotificationRow(row));
  }

  return {
    processed: results.length,
    results
  };
}

async function finalizeAcademyBooking({
  applicationId,
  candidate,
  terms,
  appointment,
  selectedTime,
  startUtc,
  endUtc,
  eventId,
  bookingFingerprint,
  rollbackGoogleEventOnDatabaseFailure = false
}) {
  let booking;

  try {
    booking = await persistAcademyBooking({
      applicationId,
      candidate,
      terms,
      appointment,
      selectedTime,
      startUtc,
      endUtc,
      eventId,
      bookingFingerprint
    });
  } catch (err) {
    if (rollbackGoogleEventOnDatabaseFailure) {
      try {
        const encodedCalendarId = encodeURIComponent(GOOGLE_CALENDAR_ID);
        await googleCalendarRequest(
          `/calendars/${encodedCalendarId}/events/${encodeURIComponent(eventId)}`,
          { method: "DELETE" }
        );
      } catch (rollbackError) {
        console.error(
          "Academy booking database rollback could not delete Google event:",
          rollbackError
        );
      }
    }

    throw err;
  }

  let zoomWarning = null;

  try {
    booking = await ensureAcademyZoomMeeting(booking);
  } catch (err) {
    zoomWarning = String(err?.message || err);
    console.error(
      "Academy booking confirmed, but Zoom meeting creation failed. It will be retried before the 2-hour reminder:",
      err
    );
  }

  let queueResult = {
    queued: 0
  };
  let confirmationResult = {
    processed: 0,
    results: []
  };
  let notificationWarning = null;

  try {
    queueResult = await queueAcademyNotifications(booking);
    confirmationResult = await processAcademyNotificationQueue({
      bookingId: booking.id,
      confirmationOnly: true
    });
  } catch (err) {
    notificationWarning = String(err?.message || err);
    console.error(
      "Academy booking confirmed, but notification setup/send failed:",
      err
    );
  }

  return {
    booking,
    queueResult,
    confirmationResult,
    notificationWarning,
    zoomWarning
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

// LL Brows Academy application persistence.
// Saves the complete application server-side before the candidate reaches
// the scheduling page.
app.post("/academy/application", checkoutLimiter, async (req, res) => {
  try {
    const application = normalizeAcademyApplication(req.body || {});

    if (
      !application.fullName ||
      !application.phone ||
      !isValidEmail(application.email) ||
      !application.city ||
      !application.state ||
      !application.stage ||
      !application.interest ||
      !application.previousTraining ||
      !application.timeline ||
      !application.investmentReadiness
    ) {
      return res.status(400).json({
        ok: false,
        code: "INVALID_APPLICATION",
        error: "Please complete all required application fields."
      });
    }

    if (!application.attendanceAgreement) {
      return res.status(400).json({
        ok: false,
        code: "ATTENDANCE_AGREEMENT_REQUIRED",
        error: "The attendance agreement is required."
      });
    }

    const record = {
      full_name: application.fullName,
      phone: application.phone,
      email: application.email,
      instagram: application.instagram || null,
      city: application.city,
      state: application.state,
      stage: application.stage,
      interest: application.interest,
      previous_training: application.previousTraining,
      experience: application.experience || null,
      goals: application.goals,
      challenges: application.challenges,
      timeline: application.timeline,
      investment_readiness: application.investmentReadiness,
      notes: application.notes || null,
      attendance_agreement: application.attendanceAgreement,
      sms_reminders: application.smsReminders,
      marketing_optin: application.marketingOptin,
      source: application.source,
      status: "submitted",
      payload: req.body || {}
    };

    const { data, error } = await academySupabase
      .from("academy_applications")
      .insert(record)
      .select("id, created_at")
      .single();

    if (error || !data) {
      console.error("Academy application insert failed:", error);

      return res.status(503).json({
        ok: false,
        code: "APPLICATION_DATABASE_ERROR",
        error: "We couldn’t save your application. Please try again."
      });
    }

    return res.status(201).json({
      status: 201,
      ok: true,
      applicationId: data.id,
      createdAt: data.created_at
    });
  } catch (err) {
    console.error("Erro /academy/application:", err);

    return res.status(500).json({
      ok: false,
      code: "APPLICATION_SAVE_FAILED",
      error: "We couldn’t save your application. Please try again."
    });
  }
});


// LL Brows Academy — next dates that actually contain openings.
// Scans forward using Vagaro's returned appointmentDate as a jump cursor,
// which avoids querying every empty calendar day one by one.
app.post("/vagaro/academy-available-dates", checkoutLimiter, async (req, res) => {
  try {
    const startDate =
      formatDateOnly(req.body?.startDate) ||
      formatDateOnly(req.body?.start_date) ||
      academyEasternTodayISO();

    const maxDays = Math.max(
      1,
      Math.min(Number(req.body?.maxDays) || 30, 45)
    );

    const maxDates = Math.max(
      1,
      Math.min(Number(req.body?.maxDates) || 8, 12)
    );

    const result = await discoverAcademyAvailableDates({
      startDate,
      maxDays,
      maxDates
    });

    return res.json({
      status: 200,
      ok: true,
      message: "Success",
      source: "LL Brows Academy",
      service: {
        serviceId: VAGARO_ACADEMY_SERVICE_ID,
        title: VAGARO_ACADEMY_SERVICE_TITLE,
        durationMinutes: VAGARO_ACADEMY_DURATION_MINUTES
      },
      professional: {
        name: "Ludimilla Leite",
        serviceProviderId: VAGARO_LUDIMILLA_PROVIDER_ID
      },
      ...result
    });
  } catch (err) {
    console.error("Erro /vagaro/academy-available-dates:", err);

    return res.status(500).json({
      ok: false,
      error: "Could not load Academy available dates",
      details: err.message
    });
  }
});


// LL Brows Academy availability.
// Uses the same Vagaro business/provider as LL Touch, but does not depend on
// Stripe checkout or alter the existing LL Touch /vagaro/availability route.
app.post("/vagaro/academy-availability", checkoutLimiter, async (req, res) => {
  try {
    const date = formatDateOnly(req.body?.date);

    if (!date) {
      return res.status(400).json({
        error: "Invalid date. Use YYYY-MM-DD."
      });
    }

    const availability = await searchVagaroAvailability({
      date,
      serviceId: VAGARO_ACADEMY_SERVICE_ID,
      addOnIds: []
    });

    const googleBusyEvents = await getAcademyGoogleBusyEventsForRange(
      date,
      date
    );

    const vagaroSlots = normalizeAcademyAvailability(
      availability,
      date
    ).filter(
      (slot) => normalizeAcademyDateValue(slot.date, null) === date
    );

    const slots = filterAcademySlotsAgainstGoogle(
      vagaroSlots,
      googleBusyEvents
    );

    return res.json({
      status: 200,
      message: "Success",
      source: "LL Brows Academy",
      date,
      service: {
        serviceId: VAGARO_ACADEMY_SERVICE_ID,
        title: VAGARO_ACADEMY_SERVICE_TITLE,
        durationMinutes: VAGARO_ACADEMY_DURATION_MINUTES
      },
      professional: {
        name: "Ludimilla Leite",
        serviceProviderId: VAGARO_LUDIMILLA_PROVIDER_ID
      },
      googleBusyEventsChecked: googleBusyEvents.length,
      slots
    });
  } catch (err) {
    console.error("Erro /vagaro/academy-availability:", err);

    return res.status(500).json({
      error: "Could not load Academy Vagaro availability",
      details: err.message
    });
  }
});

// Safe Google Calendar connectivity test.
// READ-ONLY: it does not create, update or delete any event.
app.get("/academy/google-calendar-check", checkoutLimiter, async (req, res) => {
  try {
    if (!isGoogleCalendarConfigured()) {
      return res.status(503).json({
        ok: false,
        error: "Google Calendar environment variables are incomplete."
      });
    }

    const encodedCalendarId = encodeURIComponent(GOOGLE_CALENDAR_ID);
    const data = await googleCalendarRequest(
      `/calendars/${encodedCalendarId}/events?maxResults=1&singleEvents=true`
    );

    return res.json({
      status: 200,
      ok: true,
      calendarConfigured: true,
      serviceAccount: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      timezone: GOOGLE_CALENDAR_TIMEZONE,
      calendarAccessible: true,
      sampleEventsReturned: Array.isArray(data?.items) ? data.items.length : 0,
      message: "Google Calendar connection is working."
    });
  } catch (err) {
    console.error("Erro /academy/google-calendar-check:", err);

    return res.status(500).json({
      status: 500,
      ok: false,
      calendarAccessible: false,
      error: "Google Calendar connection failed.",
      details: err.message
    });
  }
});

// Final LL Brows Academy booking confirmation.
// Revalidates Vagaro, checks Google Calendar conflicts, then creates one
// deterministic BUSY event. The deterministic event ID protects the slot
// against duplicate submissions across Render instances.
app.post("/academy/confirm-session", checkoutLimiter, async (req, res) => {
  const candidate = extractAcademyCandidate(req.body || {});
  const appointment = extractAcademyAppointment(req.body || {});
  const terms = extractAcademyTerms(req.body || {});
  const applicationId = academyUuid(
    req.body?.applicationId ||
    req.body?.application_id
  );

  if (!candidate.fullName || !isValidEmail(candidate.email) || !candidate.phone) {
    return res.status(400).json({
      ok: false,
      code: "INVALID_CANDIDATE",
      error: "Full name, valid email and phone are required."
    });
  }

  if (!appointment.date) {
    return res.status(400).json({
      ok: false,
      code: "INVALID_DATE",
      error: "A valid appointment date is required."
    });
  }

  const selectedTime = normalizeAcademyTime(appointment.timeRaw);

  if (!selectedTime) {
    return res.status(400).json({
      ok: false,
      code: "INVALID_TIME",
      error: "A valid appointment time is required."
    });
  }

  if (!terms.attend || !terms.quietSpace) {
    return res.status(400).json({
      ok: false,
      code: "TERMS_REQUIRED",
      error: "Required session commitments must be accepted."
    });
  }

  if (!isGoogleCalendarConfigured()) {
    return res.status(503).json({
      ok: false,
      code: "CALENDAR_NOT_CONFIGURED",
      error: "Google Calendar is not configured."
    });
  }

  // 1) Revalidate against Vagaro immediately before booking.
  let availability;

  try {
    availability = await searchVagaroAvailability({
      date: appointment.date,
      serviceId: VAGARO_ACADEMY_SERVICE_ID,
      addOnIds: []
    });
  } catch (err) {
    console.error("Academy confirmation Vagaro revalidation failed:", err);

    return res.status(503).json({
      ok: false,
      code: "VAGARO_REVALIDATION_FAILED",
      error: "We could not re-check the selected time. Please try again."
    });
  }

  const currentSlots = normalizeAcademyAvailability(
    availability,
    appointment.date
  );

  const matchingSlot = currentSlots.find(
    (slot) =>
      formatDateOnly(slot.date || appointment.date) === appointment.date &&
      normalizeAcademyTime(slot.time) === selectedTime
  );

  if (!matchingSlot) {
    return res.status(409).json({
      ok: false,
      code: "SLOT_NO_LONGER_AVAILABLE",
      error: "That time is no longer available. Please choose another time."
    });
  }

  const endWallClock = addAcademyMinutes(
    appointment.date,
    selectedTime,
    VAGARO_ACADEMY_DURATION_MINUTES
  );

  if (!endWallClock) {
    return res.status(400).json({
      ok: false,
      code: "INVALID_APPOINTMENT",
      error: "Could not calculate the appointment duration."
    });
  }

  let startUtc;
  let endUtc;

  try {
    startUtc = zonedAcademyDateToUtc(
      appointment.date,
      selectedTime,
      GOOGLE_CALENDAR_TIMEZONE
    );

    endUtc = zonedAcademyDateToUtc(
      endWallClock.date,
      endWallClock.time,
      GOOGLE_CALENDAR_TIMEZONE
    );
  } catch (err) {
    console.error("Academy timezone conversion failed:", err);

    return res.status(400).json({
      ok: false,
      code: "INVALID_TIMEZONE_VALUE",
      error: "Could not process the selected appointment time."
    });
  }

  const eventId = academySlotEventId(appointment.date, selectedTime);
  const bookingFingerprint = academyBookingFingerprint(
    candidate.email,
    appointment.date,
    selectedTime
  );

  // 2) Check Google Calendar as a second source of truth.
  let conflicts;

  try {
    conflicts = await getAcademyGoogleConflicts(startUtc, endUtc);
  } catch (err) {
    console.error("Academy Google Calendar conflict check failed:", err);

    return res.status(503).json({
      ok: false,
      code: "GOOGLE_CONFLICT_CHECK_FAILED",
      error: "We could not verify the calendar. Please try again."
    });
  }

  const existingSameBooking = conflicts.find(
    (event) =>
      event.id === eventId &&
      event.extendedProperties?.private?.bookingFingerprint === bookingFingerprint
  );

  if (existingSameBooking) {
    let finalization = null;

    try {
      finalization = await finalizeAcademyBooking({
        applicationId,
        candidate,
        terms,
        appointment,
        selectedTime,
        startUtc,
        endUtc,
        eventId: existingSameBooking.id,
        bookingFingerprint,
        rollbackGoogleEventOnDatabaseFailure: false
      });
    } catch (err) {
      console.error(
        "Existing Academy booking could not be persisted:",
        err
      );
    }

    clearAcademyAvailableDatesCache();

    return res.json({
      status: 200,
      ok: true,
      bookingConfirmed: true,
      alreadyConfirmed: true,
      appointment: {
        date: appointment.date,
        time: academyDisplayTime(selectedTime),
        durationMinutes: VAGARO_ACADEMY_DURATION_MINUTES,
        timeZone: GOOGLE_CALENDAR_TIMEZONE,
        professional: "Ludimilla Leite",
        service: VAGARO_ACADEMY_SERVICE_TITLE
      },
      eventId: existingSameBooking.id,
      bookingId: finalization?.booking?.id || null,
      notifications: {
        queued: finalization?.queueResult?.queued || 0,
        confirmationProcessed:
          finalization?.confirmationResult?.processed || 0,
        warning: finalization?.notificationWarning || null
      }
    });
  }

  if (conflicts.length > 0) {
    return res.status(409).json({
      ok: false,
      code: "GOOGLE_SLOT_CONFLICT",
      error: "That time has just been taken. Please choose another time."
    });
  }

  // 3) Create one private BUSY event in the Academy Google Calendar.
  const eventBody = {
    id: eventId,
    summary: `LL Brows Academy – Consultation Call | ${candidate.fullName}`,
    description: [
      "Private PMU Career & Business Audit",
      `Candidate: ${candidate.fullName}`,
      `Email: ${candidate.email}`,
      `Phone: ${candidate.phone}`,
      `Reminder consent: ${terms.reminders ? "yes" : "no"}`,
      "Source: LL Brows Academy funnel"
    ].join("\n"),
    location: "Private online session",
    status: "confirmed",
    visibility: "private",
    transparency: "opaque",
    start: {
      dateTime: `${appointment.date}T${selectedTime}:00`,
      timeZone: GOOGLE_CALENDAR_TIMEZONE
    },
    end: {
      dateTime: `${endWallClock.date}T${endWallClock.time}:00`,
      timeZone: GOOGLE_CALENDAR_TIMEZONE
    },
    extendedProperties: {
      private: {
        llBrowsAcademy: "1",
        bookingFingerprint,
        candidateEmail: candidate.email,
        appointmentDate: appointment.date,
        appointmentTime: selectedTime
      }
    }
  };

  const encodedCalendarId = encodeURIComponent(GOOGLE_CALENDAR_ID);

  try {
    const createdEvent = await googleCalendarRequest(
      `/calendars/${encodedCalendarId}/events?sendUpdates=none`,
      {
        method: "POST",
        body: eventBody
      }
    );

    let finalization;

    try {
      finalization = await finalizeAcademyBooking({
        applicationId,
        candidate,
        terms,
        appointment,
        selectedTime,
        startUtc,
        endUtc,
        eventId: createdEvent.id,
        bookingFingerprint,
        rollbackGoogleEventOnDatabaseFailure: true
      });
    } catch (err) {
      console.error(
        "Academy Google event was created but database persistence failed:",
        err
      );

      return res.status(503).json({
        ok: false,
        code: "BOOKING_DATABASE_ERROR",
        error:
          "We couldn’t safely finish the reservation. Please try again."
      });
    }

    clearAcademyAvailableDatesCache();

    return res.status(201).json({
      status: 201,
      ok: true,
      bookingConfirmed: true,
      alreadyConfirmed: false,
      appointment: {
        date: appointment.date,
        time: academyDisplayTime(selectedTime),
        durationMinutes: VAGARO_ACADEMY_DURATION_MINUTES,
        timeZone: GOOGLE_CALENDAR_TIMEZONE,
        professional: "Ludimilla Leite",
        service: VAGARO_ACADEMY_SERVICE_TITLE
      },
      eventId: createdEvent.id,
      bookingId: finalization.booking.id,
      notifications: {
        queued: finalization.queueResult.queued,
        confirmationProcessed:
          finalization.confirmationResult.processed,
        warning: finalization.notificationWarning
      }
    });
  } catch (err) {
    if (Number(err.status) === 409) {
      try {
        const afterRaceConflicts = await getAcademyGoogleConflicts(
          startUtc,
          endUtc
        );

        const sameBookingAfterRace = afterRaceConflicts.find(
          (event) =>
            event.id === eventId &&
            event.extendedProperties?.private?.bookingFingerprint === bookingFingerprint
        );

        if (sameBookingAfterRace) {
          let finalization = null;

          try {
            finalization = await finalizeAcademyBooking({
              applicationId,
              candidate,
              terms,
              appointment,
              selectedTime,
              startUtc,
              endUtc,
              eventId: sameBookingAfterRace.id,
              bookingFingerprint,
              rollbackGoogleEventOnDatabaseFailure: false
            });
          } catch (finalizeError) {
            console.error(
              "Academy post-race persistence failed:",
              finalizeError
            );
          }

          clearAcademyAvailableDatesCache();

          return res.json({
            status: 200,
            ok: true,
            bookingConfirmed: true,
            alreadyConfirmed: true,
            appointment: {
              date: appointment.date,
              time: academyDisplayTime(selectedTime),
              durationMinutes: VAGARO_ACADEMY_DURATION_MINUTES,
              timeZone: GOOGLE_CALENDAR_TIMEZONE,
              professional: "Ludimilla Leite",
              service: VAGARO_ACADEMY_SERVICE_TITLE
            },
            eventId: sameBookingAfterRace.id,
            bookingId: finalization?.booking?.id || null,
            notifications: {
              queued: finalization?.queueResult?.queued || 0,
              confirmationProcessed:
                finalization?.confirmationResult?.processed || 0,
              warning: finalization?.notificationWarning || null
            }
          });
        }
      } catch (raceCheckError) {
        console.error(
          "Academy post-race conflict check failed:",
          raceCheckError
        );
      }

      return res.status(409).json({
        ok: false,
        code: "SLOT_JUST_TAKEN",
        error: "That time has just been taken. Please choose another time."
      });
    }

    console.error("Academy Google Calendar event creation failed:", err);

    return res.status(503).json({
      ok: false,
      code: "GOOGLE_EVENT_CREATE_FAILED",
      error: "We could not confirm the appointment. Please try again."
    });
  }
});

// Secure worker endpoint for confirmation/remainder delivery.
// Render Cron should call this route every 5 minutes.
app.post("/academy/process-reminders", async (req, res) => {
  const authorization = String(req.headers.authorization || "");
  const suppliedSecret = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";

  if (!ACADEMY_CRON_SECRET) {
    return res.status(503).json({
      ok: false,
      error: "ACADEMY_CRON_SECRET is not configured."
    });
  }

  const expected = Buffer.from(ACADEMY_CRON_SECRET);
  const received = Buffer.from(suppliedSecret);

  const authorized =
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received);

  if (!authorized) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized."
    });
  }

  try {
    const result = await processAcademyNotificationQueue();

    return res.json({
      status: 200,
      ok: true,
      ...result
    });
  } catch (err) {
    console.error("Erro /academy/process-reminders:", err);

    return res.status(500).json({
      ok: false,
      error: "Could not process Academy reminders.",
      details: String(err?.message || err)
    });
  }
});

app.get("/academy/zoom-check", async (_, res) => {
  if (!isAcademyZoomConfigured()) {
    return res.status(503).json({
      status: 503,
      ok: false,
      zoomConfigured: false,
      error: "Zoom is not fully configured in Render environment variables."
    });
  }

  try {
    await getAcademyZoomAccessToken();

    return res.json({
      status: 200,
      ok: true,
      zoomConfigured: true,
      hostConfigured: Boolean(ZOOM_HOST_EMAIL),
      message: "Zoom Server-to-Server OAuth connection is working."
    });
  } catch (err) {
    console.error("Erro /academy/zoom-check:", err);

    return res.status(503).json({
      status: 503,
      ok: false,
      zoomConfigured: true,
      error: "Zoom OAuth connection failed.",
      details: String(err?.message || err)
    });
  }
});

app.get("/academy/system-check", async (_, res) => {
  const checks = {
    databaseConfigured: Boolean(
      process.env.SUPABASE_URL &&
      (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY)
    ),
    googleCalendarConfigured: isGoogleCalendarConfigured(),
    emailConfigured: isAcademyEmailConfigured(),
    internalEmailMode: "client-web3forms",
    smsConfigured: isAcademySmsConfigured(),
    zoomConfigured: isAcademyZoomConfigured(),
    zoomHostConfigured: Boolean(ZOOM_HOST_EMAIL),
    cronSecretConfigured: Boolean(ACADEMY_CRON_SECRET)
  };

  let databaseTablesAccessible = false;
  let databaseError = null;

  try {
    const { error } = await academySupabase
      .from("academy_applications")
      .select("id")
      .limit(1);

    if (error) {
      databaseError = error.message || String(error);
    } else {
      databaseTablesAccessible = true;
    }
  } catch (err) {
    databaseError = String(err?.message || err);
  }

  return res.json({
    status: 200,
    ok:
      checks.databaseConfigured &&
      databaseTablesAccessible &&
      checks.googleCalendarConfigured,
    checks: {
      ...checks,
      databaseTablesAccessible
    },
    databaseError
  });
});

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

app.get("/health/supabase", async (_, res) => {
  try {
    const { error } = await supabase
      .from("customers")
      .select("email")
      .limit(1);

    if (error) {
      return res.status(503).json({
        ok: false,
        supabaseReachable: false,
        message: "Supabase responded with an error.",
        details: error.message || String(error)
      });
    }

    return res.json({
      ok: true,
      supabaseReachable: true,
      message: "Supabase connection is working."
    });
  } catch (err) {
    return res.status(503).json({
      ok: false,
      supabaseReachable: false,
      message: "Supabase connection failed.",
      details: err.message || String(err)
    });
  }
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
    },
    academyCalendar: {
      configured: isGoogleCalendarConfigured(),
      timezone: GOOGLE_CALENDAR_TIMEZONE,
      applicationRoute: "/academy/application",
      availableDatesRoute: "/vagaro/academy-available-dates",
      availabilityRoute: "/vagaro/academy-availability",
      googleCheckRoute: "/academy/google-calendar-check",
      confirmRoute: "/academy/confirm-session",
      reminderWorkerRoute: "/academy/process-reminders",
      systemCheckRoute: "/academy/system-check",
      zoomCheckRoute: "/academy/zoom-check",
      emailConfigured: isAcademyEmailConfigured(),
      internalEmailMode: "client-web3forms",
      internalEmailRecipient: "lltouch@outlook.com",
      smsConfigured: isAcademySmsConfigured(),
      zoomConfigured: isAcademyZoomConfigured(),
      zoomHostConfigured: Boolean(ZOOM_HOST_EMAIL),
      cronSecretConfigured: Boolean(ACADEMY_CRON_SECRET)
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