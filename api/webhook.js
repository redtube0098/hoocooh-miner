const { getDb } = require("../lib/mongodb");

const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || "hoocooh_admin_2026";

function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function getAdminTelegramIds(db) {
  const ids = new Set();
  
  // 1. From Vercel Environment Variable (comma separated or single)
  if (process.env.ADMIN_TELEGRAM_ID) {
    process.env.ADMIN_TELEGRAM_ID.split(",").forEach(id => {
      const trimmed = id.trim();
      if (trimmed) ids.add(trimmed);
    });
  }

  // 2. From MongoDB settings or admins collection
  try {
    if (db) {
      const setting = await db.collection("settings").findOne({ key: "bot_settings" });
      if (setting && setting.adminTelegramId) {
        String(setting.adminTelegramId).split(",").forEach(id => {
          const trimmed = id.trim();
          if (trimmed) ids.add(trimmed);
        });
      }
      const adminDocs = await db.collection("admins").find({}).toArray();
      adminDocs.forEach(doc => {
        if (doc.telegramId) ids.add(String(doc.telegramId).trim());
      });
    }
  } catch (e) {
    console.error("Error fetching admin IDs from DB:", e);
  }

  return ids;
}

async function sendTelegramMsg(botToken, chatId, text, options = {}) {
  if (!botToken || !chatId) return false;
  try {
    const payload = {
      chat_id: String(chatId),
      parse_mode: "HTML",
      disable_web_page_preview: false
    };

    let url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    if (options.photoUrl) {
      url = `https://api.telegram.org/bot${botToken}/sendPhoto`;
      payload.photo = options.photoUrl;
      payload.caption = text;
    } else {
      payload.text = text;
    }

    if (options.reply_markup) {
      payload.reply_markup = options.reply_markup;
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    return data;
  } catch (e) {
    console.error("sendTelegramMsg error:", e);
    return null;
  }
}

module.exports = async (req, res) => {
  // CORS / Preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const baseUrl = `${protocol}://${host}`;

  // ==========================================
  // GET: Setup Webhook & Diagnostics Helper
  // ==========================================
  if (req.method === "GET") {
    const { action, setup, setWebhook, info, key, id } = req.query || {};

    if (!botToken) {
      res.status(500).json({
        ok: false,
        error: "TELEGRAM_BOT_TOKEN is not configured in Vercel environment variables."
      });
      return;
    }

    // Quick Webhook Registration: /api/webhook?setup=1 or /api/webhook?action=set
    if (setup === "1" || setWebhook === "1" || action === "set") {
      try {
        const webhookUrl = `${baseUrl}/api/webhook`;
        const tgRes = await fetch(
          `https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}&drop_pending_updates=true`
        );
        const tgData = await tgRes.json();
        res.status(200).json({
          ok: true,
          message: "Telegram Webhook set successfully!",
          webhookUrl,
          telegramResponse: tgData
        });
        return;
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
        return;
      }
    }

    // Webhook Info: /api/webhook?info=1
    if (info === "1" || action === "info") {
      try {
        const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
        const tgData = await tgRes.json();
        res.status(200).json({ ok: true, info: tgData });
        return;
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
        return;
      }
    }

    // Set Admin Telegram ID helper: /api/webhook?action=set_admin&id=123456789&key=SECRET
    if (action === "set_admin" && id && key) {
      if (String(key).trim() !== String(ADMIN_SECRET).trim()) {
        res.status(401).json({ error: "Invalid Admin Secret Key" });
        return;
      }
      try {
        const db = await getDb();
        await db.collection("settings").updateOne(
          { key: "bot_settings" },
          { $set: { adminTelegramId: String(id).trim(), updatedAt: Date.now() } },
          { upsert: true }
        );
        res.status(200).json({
          ok: true,
          message: `Admin Telegram ID successfully set to: ${id}`
        });
        return;
      } catch (err) {
        res.status(500).json({ error: err.message });
        return;
      }
    }

    // Default status
    let dbAdmins = [];
    try {
      const db = await getDb();
      const adminSet = await getAdminTelegramIds(db);
      dbAdmins = Array.from(adminSet);
    } catch(e){}

    res.status(200).json({
      ok: true,
      service: "HOOCOOH Telegram Webhook",
      hasBotToken: !!botToken,
      registeredAdminIds: dbAdmins,
      help: {
        setupWebhook: `${baseUrl}/api/webhook?setup=1`,
        checkWebhook: `${baseUrl}/api/webhook?info=1`
      }
    });
    return;
  }

  // ==========================================
  // POST: Telegram Webhook Update Handler
  // ==========================================
  if (req.method === "POST") {
    let update = req.body;
    if (typeof update === "string") {
      try { update = JSON.parse(update); } catch(e){}
    }

    if (!update) {
      res.status(200).send("OK");
      return;
    }

    const message = update.message || update.edited_message;
    if (!message || !message.text) {
      // Not a text message, ignore silently
      res.status(200).send("OK");
      return;
    }

    const text = (message.text || "").trim();
    const chatId = message.chat.id;
    const senderId = message.from && message.from.id ? String(message.from.id) : "";
    const firstName = message.from?.first_name || "Admin";

    const parts = text.split(/\s+/);
    const firstWord = parts[0].toLowerCase();
    const command = firstWord.split("@")[0]; // removes bot username e.g. /admin@mybot -> /admin

    // ----------------------------------------------------
    // Command: /admin
    // ----------------------------------------------------
    if (command === "/admin") {
      let db = null;
      try { db = await getDb(); } catch(e){}
      const adminIds = await getAdminTelegramIds(db);

      // Strict Security Check:
      // If the sender is NOT the admin ID, do ABSOLUTELY NOTHING.
      // Silently return 200 OK so regular users get no response.
      if (!senderId || !adminIds.has(senderId)) {
        res.status(200).json({ ok: true, ignored: true });
        return;
      }

      // SENDER IS VERIFIED ADMIN!
      // Send secure WebApp launch button for Admin Panel
      const adminUrl = `${baseUrl}/admin.html`;
      const replyText = 
        `🛡️ <b>HOOCOOH Admin Control Center</b>\n\n` +
        `Welcome back, <b>${escapeHtml(firstName)}</b> (ID: <code>${senderId}</code>)!\n\n` +
        `Tap the button below to open your control panel securely:`;

      await sendTelegramMsg(botToken, chatId, replyText, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🛡️ Open Admin Panel",
                web_app: { url: adminUrl }
              }
            ]
          ]
        }
      });

      res.status(200).json({ ok: true, sent: true });
      return;
    }

    // ----------------------------------------------------
    // Command: /start
    // ----------------------------------------------------
    if (command === "/start") {
      const appUrl = `${baseUrl}/index.html`;
      const replyText = 
        `⛏️ <b>Welcome to HOOCOOH Miner!</b>\n\n` +
        `Start mining HOOCOOH coins, complete community tasks, upgrade your miners up to Level 10, and withdraw your earnings directly in USDT (TRC-20)!\n\n` +
        `Tap the button below to launch the Miner app 👇`;

      await sendTelegramMsg(botToken, chatId, replyText, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🚀 Play HOOCOOH Miner",
                web_app: { url: appUrl }
              }
            ],
            [
              {
                text: "📢 Official Channel",
                url: "https://t.me/hoocooh_miner"
              }
            ]
          ]
        }
      });

      res.status(200).json({ ok: true, sent: true });
      return;
    }

    // All other messages - return 200 OK
    res.status(200).send("OK");
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
};
