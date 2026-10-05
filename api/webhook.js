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
    const basePayload = {
      chat_id: String(chatId),
      parse_mode: "HTML",
      disable_web_page_preview: false
    };

    if (options.reply_markup) {
      basePayload.reply_markup = options.reply_markup;
    }

    // If photoUrl is provided, send as photo with caption
    if (options.photoUrl) {
      try {
        const photoPayload = Object.assign({}, basePayload, {
          photo: options.photoUrl,
          caption: text
        });
        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(photoPayload)
        });
        const data = await res.json();
        if (data && data.ok) return data;
        console.warn("sendPhoto was not ok, falling back to sendMessage:", data);
      } catch (photoErr) {
        console.warn("sendPhoto error, falling back to sendMessage:", photoErr);
      }
    }

    // Fallback: send text message
    const textPayload = Object.assign({}, basePayload, {
      text: text
    });
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(textPayload)
    });
    const data = await res.json();
    return data;
  } catch (e) {
    console.error("sendTelegramMsg error:", e);
    return null;
  }
}

const WELCOME_MESSAGES = {
  en: {
    name: "English",
    text: 
`⛏️ <b>Welcome to HOOCOOH Miner!</b>

🌕 <b>Mine the depths, earn HOOCOOH Coins, invite your crew, and withdraw real USDT!</b>

🎮 <b>How it works:</b>

• Dive deep to Mine & Earn
• Complete tasks to stack more HOOCOOH Coins
• Upgrade your mining gear for bigger rewards
• Invite friends to expand your crew & Earn
• Withdraw your earnings directly as USDT!

<b>Convert HOOCOOH Coins ➔ USDT 💲</b>

👇 <b>Tap the button below to start your dive!</b> 👇`,
    btnStart: "⛏️ Start hoocooh miner",
    btnLang: "🌐 Select your language",
    promptLang: "• <b>Language</b>\nChoose your language:",
    toastChanged: "✅ Language set to English!"
  },
  ru: {
    name: "Русский",
    text: 
`⛏️ <b>Добро пожаловать в HOOCOOH Miner!</b>

🌕 <b>Добывайте в глубинах, зарабатывайте HOOCOOH Coins, приглашайте друзей и выводите реальные USDT!</b>

🎮 <b>Как это работает:</b>

• Погружайтесь в шахту, чтобы майнить и зарабатывать
• Выполняйте задания, чтобы получить больше монет
• Улучшайте снаряжение для максимальных наград
• Приглашайте друзей в свою команду и зарабатывайте вместе
• Выводите заработанные средства прямо в USDT!

<b>Конвертируйте HOOCOOH Coins ➔ USDT 💲</b>

👇 <b>Нажмите кнопку ниже, чтобы начать погружение!</b> 👇`,
    btnStart: "⛏️ Начать майнинг hoocooh",
    btnLang: "🌐 Выбрать язык",
    promptLang: "• <b>Язык</b>\nВыберите ваш язык:",
    toastChanged: "✅ Язык изменен на Русский!"
  },
  ar: {
    name: "العربية",
    text: 
`⛏️ <b>مرحبًا بك في HOOCOOH Miner!</b>

🌕 <b>قم بالتعدين في الأعماق، واكسب عملات HOOCOOH، وادعُ أصدقاءك، واسحب عملات USDT حقيقية!</b>

🎮 <b>كيف يعمل:</b>

• انغمس в الأعماق للتعدين والربح
• أكمل المهام لجمع المزيد من عملات HOOCOOH
• قم بترقية معدات التعدين للحصول على أكبر المكافآت
• ادعُ أصدقاءك للانضمام إلى فريقك والربح معًا
• اسحب أرباحك مباشرة كعملة USDT!

<b>تحويل عملات HOOCOOH ➔ USDT 💲</b>

👇 <b>اضغط على الزر أدناه لبدء التعدين!</b> 👇`,
    btnStart: "⛏️ ابدأ تعدين hoocooh",
    btnLang: "🌐 اختر لغتك",
    promptLang: "• <b>اللغة</b>\nاختر لغتك:",
    toastChanged: "✅ تم تعيين اللغة إلى العربية!"
  }
};

async function answerCallbackQuery(botToken, callbackQueryId, text) {
  if (!botToken || !callbackQueryId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: String(callbackQueryId),
        text: text || ""
      })
    });
  } catch(e){}
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

    // ----------------------------------------------------
    // Callback Query Handler (Language Selection)
    // ----------------------------------------------------
    if (update.callback_query) {
      const cb = update.callback_query;
      const cbData = cb.data || "";
      const cbChatId = cb.message?.chat?.id;
      const cbSenderId = cb.from?.id ? String(cb.from.id) : "";

      let db = null;
      try { db = await getDb(); } catch(e){}

      // Open Language Selection menu
      if (cbData === "choose_lang") {
        let userLang = "en";
        try {
          if (db) {
            const u = await db.collection("users").findOne({ telegramId: cbSenderId });
            if (u && u.language) userLang = u.language;
          }
        } catch(e){}

        const langDict = WELCOME_MESSAGES[userLang] || WELCOME_MESSAGES.en;

        await sendTelegramMsg(botToken, cbChatId, langDict.promptLang, {
          reply_markup: {
            inline_keyboard: [
              [{ text: userLang === "en" ? "English ✓" : "English", callback_data: "set_lang_en" }],
              [{ text: userLang === "ru" ? "Русский ✓" : "Русский", callback_data: "set_lang_ru" }],
              [{ text: userLang === "ar" ? "العربية ✓" : "العربية", callback_data: "set_lang_ar" }]
            ]
          }
        });
        await answerCallbackQuery(botToken, cb.id);
        res.status(200).json({ ok: true });
        return;
      }

      // User selected a language option
      if (cbData.startsWith("set_lang_")) {
        const chosenLang = cbData.replace("set_lang_", "");
        const validLangs = ["en", "ru", "ar"];
        const finalLang = validLangs.includes(chosenLang) ? chosenLang : "en";

        try {
          if (db) {
            await db.collection("users").updateOne(
              { telegramId: cbSenderId },
              { $set: { language: finalLang, updatedAt: Date.now() } },
              { upsert: true }
            );
          }
        } catch(e){}

        const langDict = WELCOME_MESSAGES[finalLang] || WELCOME_MESSAGES.en;
        await answerCallbackQuery(botToken, cb.id, langDict.toastChanged);

        // Send updated welcome message in newly selected language
        const appUrl = `${baseUrl}/index.html?lang=${finalLang}`;
        const photoUrl = `${baseUrl}/assets/botfather_banner.jpg`;

        await sendTelegramMsg(botToken, cbChatId, langDict.text, {
          photoUrl: photoUrl,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: langDict.btnStart,
                  web_app: { url: appUrl }
                }
              ],
              [
                {
                  text: langDict.btnLang,
                  callback_data: "choose_lang"
                }
              ]
            ]
          }
        });

        res.status(200).json({ ok: true, language: finalLang });
        return;
      }

      await answerCallbackQuery(botToken, cb.id);
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
      let userLang = "en";
      let db = null;
      try {
        db = await getDb();
        if (db) {
          const u = await db.collection("users").findOne({ telegramId: senderId });
          if (u && u.language) userLang = u.language;
        }
      } catch(e){}

      let appUrl = `${baseUrl}/index.html?lang=${userLang}`;
      const startParam = parts[1] || "";
      if (startParam) {
        appUrl += `&tgWebAppStartParam=${encodeURIComponent(startParam)}`;
      }

      const photoUrl = `${baseUrl}/assets/botfather_banner.jpg`;
      const langDict = WELCOME_MESSAGES[userLang] || WELCOME_MESSAGES.en;

      await sendTelegramMsg(botToken, chatId, langDict.text, {
        photoUrl: photoUrl,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: langDict.btnStart,
                web_app: { url: appUrl }
              }
            ],
            [
              {
                text: langDict.btnLang,
                callback_data: "choose_lang"
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
