const { MINE_INTERVAL_MS } = require("./gameLogic");

async function sendTelegramMsg(botToken, chatId, text, options = {}) {
  if (!botToken || !chatId) return false;
  try {
    const basePayload = {
      chat_id: String(chatId),
      parse_mode: "HTML",
      disable_web_page_preview: false,
      text: text
    };

    if (options.reply_markup) {
      basePayload.reply_markup = options.reply_markup;
    }

    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(basePayload)
    });
    return await res.json();
  } catch (e) {
    console.error("sendTelegramMsg error:", e.message);
    return null;
  }
}

/**
 * Scan users whose 2h mining is complete and who haven't received a reminder yet.
 * Send Telegram message with WebApp claim button matching user reference screenshot.
 */
async function processMiningReminders(db, botToken, baseUrl) {
  if (!db || !botToken) return { processed: 0, sent: 0 };
  const usersCol = db.collection("users");
  const now = Date.now();
  const cutoffTime = now - MINE_INTERVAL_MS; // 2 hours ago

  // Find users whose 2-hour mining has completed, has telegramId, and reminder not sent yet
  const eligibleUsers = await usersCol.find({
    telegramId: { $exists: true, $ne: null },
    lastMineCollectedAt: { $exists: true, $ne: null, $lte: cutoffTime },
    mineReminderSent: { $ne: true }
  }).limit(40).toArray();

  let sent = 0;
  for (const user of eligibleUsers) {
    const userLang = user.language || "en";
    const appUrl = `${baseUrl}/index.html?lang=${userLang}`;

    let msgText =
      `⏰ <b>Don't forget!</b>\n\n` +
      `Your HOOCOOH is waiting to dive ⛏️\n` +
      `Log in now and collect your daily mining reward!`;
    let btnText = "⛏️ Claim HOOCOOH Coins Now";

    if (userLang === "ru") {
      msgText =
        `⏰ <b>Не забудьте!</b>\n\n` +
        `Ваш HOOCOOH готов к добыче ⛏️\n` +
        `Войдите сейчас и заберите свою награду за майнинг!`;
      btnText = "⛏️ Забрать монеты HOOCOOH";
    } else if (userLang === "ar") {
      msgText =
        `⏰ <b>لا تنسَ!</b>\n\n` +
        `تعدين HOOCOOH الخاص بك جاهز ⛏️\n` +
        `سجل الدخول الآن واجمع مكافأة التعدين الخاصة بك!`;
      btnText = "⛏️ احصل على عملات HOOCOOH الآن";
    }

    try {
      const res = await sendTelegramMsg(botToken, user.telegramId, msgText, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: btnText,
                web_app: { url: appUrl }
              }
            ]
          ]
        }
      });
      if (res && res.ok) {
        sent++;
      }
    } catch (sendErr) {
      console.warn("Failed sending mining reminder to", user.telegramId, sendErr.message);
    }

    // Mark as sent so user won't get duplicate notifications until they mine again
    await usersCol.updateOne(
      { _id: user._id },
      { $set: { mineReminderSent: true, lastMineReminderSentAt: now } }
    );
  }

  return { processed: eligibleUsers.length, sent };
}

module.exports = {
  processMiningReminders,
  sendTelegramMsg
};
