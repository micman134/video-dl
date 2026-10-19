const { Markup } = require('telegraf');
const { Pool } = require('pg');
const crypto = require('crypto');

// ---------- Config ----------
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL in environment');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  // Set DATABASE_SSL=true if you use Render's *external* database URL
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 3);
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_EMAIL_DOMAIN = process.env.PAYSTACK_EMAIL_DOMAIN || 'example.com';

// Adjust prices here or via env vars
const PLANS = {
  week: {
    label: '7 days',
    days: 7,
    stars: Number(process.env.PRICE_WEEK_STARS || 50),
    ngn: Number(process.env.PRICE_WEEK_NGN || 500),
  },
  month: {
    label: '30 days',
    days: 30,
    stars: Number(process.env.PRICE_MONTH_STARS || 150),
    ngn: Number(process.env.PRICE_MONTH_NGN || 1500),
  },
};

// "Today" is counted in Lagos time so the free limit resets at local midnight
const LAGOS_TODAY = `(now() AT TIME ZONE 'Africa/Lagos')::date`;

// ---------- Database ----------
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      telegram_id   BIGINT PRIMARY KEY,
      premium_until TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage (
      telegram_id BIGINT NOT NULL,
      day         DATE NOT NULL,
      count       INT NOT NULL DEFAULT 0,
      PRIMARY KEY (telegram_id, day)
    );
    CREATE TABLE IF NOT EXISTS payments (
      reference   TEXT PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      provider    TEXT NOT NULL,
      plan        TEXT NOT NULL,
      amount      BIGINT NOT NULL,
      status      TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at     TIMESTAMPTZ
    );
  `);
}

async function checkAccess(userId) {
  if (ADMIN_IDS.includes(userId)) {
    return { allowed: true, premium: true, until: null, admin: true, used: 0, limit: FREE_DAILY_LIMIT };
  }
  try {
    const {
      rows: [r],
    } = await pool.query(
      `SELECT (SELECT premium_until FROM subscriptions WHERE telegram_id = $1) AS until,
              COALESCE((SELECT count FROM usage WHERE telegram_id = $1 AND day = ${LAGOS_TODAY}), 0) AS used`,
      [userId]
    );
    const until = r.until ? new Date(r.until) : null;
    const premium = !!until && until > new Date();
    const used = Number(r.used);
    return { allowed: premium || used < FREE_DAILY_LIMIT, premium, until, used, limit: FREE_DAILY_LIMIT };
  } catch (err) {
    // Fail open so a database hiccup doesn't block everyone
    console.error('Access check failed (allowing download):', err.message);
    return { allowed: true, premium: false, until: null, used: 0, limit: FREE_DAILY_LIMIT };
  }
}

async function recordDownload(userId) {
  await pool.query(
    `INSERT INTO usage (telegram_id, day, count) VALUES ($1, ${LAGOS_TODAY}, 1)
     ON CONFLICT (telegram_id, day) DO UPDATE SET count = usage.count + 1`,
    [userId]
  );
}

// Adds days on top of any remaining premium time
async function grantPremium(userId, days) {
  const {
    rows: [r],
  } = await pool.query(
    `INSERT INTO subscriptions (telegram_id, premium_until)
     VALUES ($1, now() + make_interval(days => $2::int))
     ON CONFLICT (telegram_id) DO UPDATE
       SET premium_until = GREATEST(subscriptions.premium_until, now()) + make_interval(days => $2::int)
     RETURNING premium_until`,
    [userId, days]
  );
  return new Date(r.premium_until);
}

// ---------- UI helpers ----------
const fmtDate = (d) =>
  d.toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', year: 'numeric' });

function plansKeyboard() {
  const rows = [];
  for (const [key, p] of Object.entries(PLANS)) {
    const row = [Markup.button.callback(`⭐ ${p.label} · ${p.stars} Stars`, `buy:stars:${key}`)];
    if (PAYSTACK_SECRET) {
      row.push(Markup.button.callback(`💳 ${p.label} · ₦${p.ngn.toLocaleString('en-NG')}`, `buy:ngn:${key}`));
    }
    rows.push(row);
  }
  return Markup.inlineKeyboard(rows);
}

function limitText(access) {
  return (
    `You've used your ${access.limit} free downloads for today (resets at midnight, Lagos time).\n\n` +
    `Go Premium for unlimited downloads:`
  );
}

// ---------- Handlers ----------
function register(bot) {
  bot.command(['plans', 'premium'], (ctx) =>
    ctx.reply(
      `💎 Premium: unlimited downloads\nFree plan: ${FREE_DAILY_LIMIT} downloads per day.\n\nChoose a plan:`,
      plansKeyboard()
    )
  );

  bot.command('status', async (ctx) => {
    const a = await checkAccess(ctx.from.id);
    if (a.premium) {
      return ctx.reply(a.until ? `💎 Premium active until ${fmtDate(a.until)}.` : '💎 Premium (admin).');
    }
    const left = Math.max(0, a.limit - a.used);
    return ctx.reply(`Free plan: ${left} of ${a.limit} downloads left today.\n\nUse /plans for unlimited downloads.`);
  });

  // ----- Start a purchase -----
  bot.action(/^buy:(stars|ngn):(\w+)$/, async (ctx) => {
    const [, method, planKey] = ctx.match;
    const plan = PLANS[planKey];
    if (!plan) return ctx.answerCbQuery('Unknown plan.', { show_alert: true });

    try {
      if (method === 'stars') {
        await ctx.answerCbQuery();
        await ctx.telegram.callApi('sendInvoice', {
          chat_id: ctx.chat.id,
          title: `Premium · ${plan.label}`,
          description: `Unlimited downloads for ${plan.label}.`,
          payload: `stars:${planKey}:${ctx.from.id}`,
          provider_token: '', // must be empty for Telegram Stars
          currency: 'XTR',
          prices: [{ label: `Premium ${plan.label}`, amount: plan.stars }],
        });
        return;
      }

      // Paystack
      if (!PAYSTACK_SECRET) return ctx.answerCbQuery('Card payments are not available.', { show_alert: true });
      await ctx.answerCbQuery('Creating payment link...');

      const reference = 'ps_' + crypto.randomBytes(8).toString('hex');
      const res = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `tg${ctx.from.id}@${PAYSTACK_EMAIL_DOMAIN}`, // Telegram doesn't share emails
          amount: plan.ngn * 100, // kobo
          currency: 'NGN',
          reference,
          metadata: { telegram_id: ctx.from.id, plan: planKey },
        }),
      });
      const json = await res.json();
      if (!json.status) throw new Error(json.message || 'Paystack initialize failed');

      await pool.query(
        `INSERT INTO payments (reference, telegram_id, provider, plan, amount, status)
         VALUES ($1, $2, 'paystack', $3, $4, 'pending')`,
        [reference, ctx.from.id, planKey, plan.ngn * 100]
      );

      await ctx.reply(
        `Pay ₦${plan.ngn.toLocaleString('en-NG')} for Premium (${plan.label}).\n\n` +
          `1. Tap "Pay now" and complete payment\n2. Come back here and tap "I've paid"`,
        Markup.inlineKeyboard([
          [Markup.button.url('💳 Pay now', json.data.authorization_url)],
          [Markup.button.callback("✅ I've paid", `chk:${reference}`)],
        ])
      );
    } catch (err) {
      console.error('Purchase start error:', err.message);
      await ctx.reply('❌ Could not start the payment. Please try again in a moment.').catch(() => {});
    }
  });

  // ----- Paystack: verify after the user pays -----
  bot.action(/^chk:(ps_[a-f0-9]+)$/, async (ctx) => {
    const ref = ctx.match[1];
    try {
      const {
        rows: [p],
      } = await pool.query(`SELECT * FROM payments WHERE reference = $1 AND telegram_id = $2`, [ref, ctx.from.id]);
      if (!p) return ctx.answerCbQuery('Payment not found.', { show_alert: true });
      if (p.status === 'paid') return ctx.answerCbQuery('Already activated ✅', { show_alert: true });

      const res = await fetch(`https://api.paystack.co/transaction/verify/${ref}`, {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
      });
      const json = await res.json();
      const ok = json.status && json.data && json.data.status === 'success' && Number(json.data.amount) === Number(p.amount);
      if (!ok) {
        return ctx.answerCbQuery('Payment not confirmed yet. Finish paying, then tap again.', { show_alert: true });
      }

      // Claim exactly once, even if the button is tapped repeatedly
      const claimed = await pool.query(
        `UPDATE payments SET status = 'paid', paid_at = now()
         WHERE reference = $1 AND status = 'pending' RETURNING plan`,
        [ref]
      );
      if (!claimed.rowCount) return ctx.answerCbQuery('Already activated ✅', { show_alert: true });

      const until = await grantPremium(ctx.from.id, PLANS[p.plan].days);
      await ctx.answerCbQuery('Payment confirmed!');
      await ctx.editMessageText(`✅ Payment confirmed. Premium active until ${fmtDate(until)}.\nSend a link to start downloading!`);
    } catch (err) {
      console.error('Paystack verify error:', err.message);
      await ctx.answerCbQuery('Could not verify right now. Try again shortly.', { show_alert: true }).catch(() => {});
    }
  });

  // ----- Telegram Stars -----
  bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));

  bot.on('successful_payment', async (ctx) => {
    const sp = ctx.message.successful_payment;
    const [provider, planKey, uid] = (sp.invoice_payload || '').split(':');
    const plan = PLANS[planKey];

    if (
      provider !== 'stars' ||
      !plan ||
      Number(uid) !== ctx.from.id ||
      sp.currency !== 'XTR' ||
      sp.total_amount !== plan.stars
    ) {
      console.error('Unmatched payment:', JSON.stringify(sp));
      return ctx.reply(`⚠️ Payment received but couldn't be matched to a plan. Contact support with this ID: ${sp.telegram_payment_charge_id}`);
    }

    try {
      const ins = await pool.query(
        `INSERT INTO payments (reference, telegram_id, provider, plan, amount, status, paid_at)
         VALUES ($1, $2, 'stars', $3, $4, 'paid', now())
         ON CONFLICT (reference) DO NOTHING`,
        [sp.telegram_payment_charge_id, ctx.from.id, planKey, sp.total_amount]
      );
      if (!ins.rowCount) return; // already processed

      const until = await grantPremium(ctx.from.id, plan.days);
      await ctx.reply(`✅ Premium active until ${fmtDate(until)}. Send a link to start downloading!`);
    } catch (err) {
      console.error('Stars payment error:', err.message, sp.telegram_payment_charge_id);
      await ctx.reply(`⚠️ Payment received but activation failed. Contact support with this ID: ${sp.telegram_payment_charge_id}`);
    }
  });
}

module.exports = { init, register, checkAccess, recordDownload, plansKeyboard, limitText, FREE_DAILY_LIMIT };
