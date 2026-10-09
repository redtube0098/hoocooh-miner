const { MINE_INTERVAL_MS } = require("./gameLogic");

function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

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
 * Send congratulations message to inviter when a recruited friend joins and completes verification
 * Exact match to user reference screenshot media_1791524423871.png
 */
async function notifyInviterReferralSuccess(botToken, inviter, recruitUser) {
  if (!botToken || !inviter || !inviter.telegramId || !recruitUser) return false;
  try {
    const rawName = recruitUser.firstName
      ? `${recruitUser.firstName}${recruitUser.lastName ? ' ' + recruitUser.lastName : ''}`
      : (recruitUser.username ? `@${recruitUser.username}` : "A friend");
    const recruitName = escapeHtml(rawName.trim());

    const inviterLang = inviter.language || "en";

    let msg = `🎉 <b>Congratulations!</b>\n\n<b>${recruitName}</b> joined the bot using your referral link!\n\nYou got <b>+100 HOOCOOH Coins</b> 🪙.`;

    if (inviterLang === "ru") {
      msg = `🎉 <b>Поздравляем!</b>\n\n<b>${recruitName}</b> присоединился к боту по вашей реферальной ссылке!\n\nВы получили <b>+100 HOOCOOH Coins</b> 🪙.`;
    } else if (inviterLang === "ar") {
      msg = `🎉 <b>تهانينا!</b>\n\nانضم <b>${recruitName}</b> إلى البوت باستخدام رابط الإحالة الخاص بك!\n\nلقد حصلت على <b>+100 عملة HOOCOOH</b> 🪙.`;
    }

    return await sendTelegramMsg(botToken, inviter.telegramId, msg);
  } catch (err) {
    console.warn("notifyInviterReferralSuccess warning:", err.message);
    return null;
  }
}

/**
 * High-Scale Serverless-Safe Mining Reminder Processor:
 * Designed to handle 100,000+ (1 lakh+) users smoothly without Vercel timeout errors:
 * - Time-budget guard: Caps total execution to 6.5s (Vercel max is 10s on Hobby).
 * - Chunking: Processes users in controlled batches with rate limiting.
 * - MongoDB indexing: Ensures ultra-fast queries even with 100k+ users.
 * - Error isolation: Dead/blocked accounts are flagged to avoid repeated retries.
 */
let indexEnsured = false;

async function processMiningReminders(db, botToken, baseUrl) {
  if (!db || !botToken) return { processed: 0, sent: 0, hasMore: false };
  const usersCol = db.collection("users");

  // Compound index for fast queries over 100,000+ documents
  if (!indexEnsured) {
    usersCol.createIndex({
      lastMineCollectedAt: 1,
      mineReminderSent: 1,
      isBotBlocked: 1
    }).catch(() => {});
    indexEnsured = true;
  }

  const startTime = Date.now();
  const TIME_BUDGET_MS = 6500; // 6.5s hard limit for Vercel Hobby plan
  const now = Date.now();
  const cutoffTime = now - MINE_INTERVAL_MS; // 2 hours ago

  let totalProcessed = 0;
  let totalSent = 0;
  let hasMore = true;

  while (Date.now() - startTime < TIME_BUDGET_MS) {
    const remainingTime = TIME_BUDGET_MS - (Date.now() - startTime);
    if (remainingTime < 800) break;

    const batch = await usersCol.find({
      telegramId: { $exists: true, $ne: null },
      lastMineCollectedAt: { $exists: true, $ne: null, $lte: cutoffTime },
      mineReminderSent: { $ne: true },
      isBotBlocked: { $ne: true }
    })
    .project({ _id: 1, telegramId: 1, language: 1 })
    .limit(20)
    .toArray();

    if (!batch || batch.length === 0) {
      hasMore = false;
      break;
    }

    // Process chunk with concurrency of 5
    for (let i = 0; i < batch.length; i += 5) {
      if (Date.now() - startTime >= TIME_BUDGET_MS) break;

      const chunk = batch.slice(i, i + 5);
      await Promise.all(chunk.map(async (user) => {
        totalProcessed++;
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
            totalSent++;
            await usersCol.updateOne(
              { _id: user._id },
              { $set: { mineReminderSent: true, lastMineReminderSentAt: Date.now() } }
            );
          } else {
            const isBlocked = res && (res.error_code === 403 || String(res.description).includes("blocked") || String(res.description).includes("deactivated"));
            await usersCol.updateOne(
              { _id: user._id },
              { $set: { mineReminderSent: true, isBotBlocked: Boolean(isBlocked), lastMineReminderSentAt: Date.now() } }
            );
          }
        } catch (err) {
          await usersCol.updateOne(
            { _id: user._id },
            { $set: { mineReminderSent: true, lastMineReminderSentAt: Date.now() } }
          );
        }
      }));

      // Short delay between chunks to respect Telegram rate limits
      await new Promise(r => setTimeout(r, 60));
    }
  }

  return {
    processed: totalProcessed,
    sent: totalSent,
    hasMore,
    executionMs: Date.now() - startTime
  };
}

module.exports = {
  processMiningReminders,
  notifyInviterReferralSuccess,
  sendTelegramMsg
};
