const BACKEND_URL = String(
  process.env.ACADEMY_BACKEND_URL ||
  "https://stripe-checkout-1.onrender.com"
).replace(/\/+$/, "");

const SECRET = String(
  process.env.ACADEMY_CRON_SECRET || ""
).trim();

if (!SECRET) {
  console.error("ACADEMY_CRON_SECRET is missing.");
  process.exit(1);
}

const response = await fetch(
  `${BACKEND_URL}/academy/process-reminders`,
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      accept: "application/json"
    }
  }
);

const data = await response.json().catch(() => ({}));

if (!response.ok || !data.ok) {
  console.error("Academy reminder worker failed:", data);
  process.exit(1);
}

console.log(
  JSON.stringify({
    ok: true,
    processed: data.processed || 0,
    results: data.results || []
  })
);
