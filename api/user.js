const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { findOrCreateUser, findUserById } = require("../lib/userHelper");
const { mineIsReady, dailyStatus, MINE_INTERVAL_MS, LEVEL_NAMES, getMultiplierForLevel } = require("../lib/gameLogic");
const { generateVerificationImage } = require("../lib/verificationImage");

let cachedBotUsername = null;
async function fetchBotUsername(token) {
  if (cachedBotUsername) return cachedBotUsername;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await res.json();
    if (data.ok && data.result && data.result.username) {
      cachedBotUsername = data.result.username;
      return cachedBotUsername;
    }
  } catch(e) {}
  return "hoocooh_miner_bot";
}

module.exports = async (req, res) => {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    res.status(500).json({ error: "TELEGRAM_BOT_TOKEN is not set in Vercel settings" });
    return;
  }

  const initData = req.headers["x-telegram-init-data"];
  const tgUser = validateInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
  if (!tgUser) {
    res.status(401).json({ error: "Invalid session - reopen app from Telegram" });
    return;
  }
  const telegramId = String(tgUser.id);

  try {
    const db = await getDb();
    const users = db.collection("users");

    // Unified user retrieval, multi-type ID lookup, and duplicate merge
    let user = await findOrCreateUser(users, tgUser);

    if (user && user.isBanned) {
      res.status(200).json({
        isBanned: true,
        banReason: user.banReason || "Your account has been suspended",
        telegramId: user.telegramId
      });
      return;
    }

    // POST request handling (e.g. set_language)
    if (req.method === "POST") {
      const { action, language, code } = req.body || {};
      if (action === "set_language" && language) {
        const validLangs = ["en", "ru", "ar"];
        const finalLang = validLangs.includes(language) ? language : "en";
        await users.updateOne({ _id: user._id }, { $set: { language: finalLang, languageSelected: true, updatedAt: Date.now() } });
        res.status(200).json({ ok: true, language: finalLang, languageSelected: true });
        return;
      }
      if (action === "accept_terms") {
        await users.updateOne({ _id: user._id }, { $set: { termsAccepted: true, termsAcceptedAt: Date.now() } });
        res.status(200).json({ ok: true, termsAccepted: true });
        return;
      }

      // Verification: Request 4-digit verification code image
      if (action === "request_code" || action === "request_verification_code") {
        const now = Date.now();
        const codesCol = db.collection("user_verification_codes");

        // Cooldown check (15 seconds)
        const recentCode = await codesCol.findOne(
          { userId: telegramId, used: false },
          { sort: { createdAt: -1 } }
        );
        if (recentCode && (now - recentCode.createdAt < 15000)) {
          const waitSec = Math.ceil((15000 - (now - recentCode.createdAt)) / 1000);
          res.status(429).json({ error: `Please wait ${waitSec}s before requesting a new code.` });
          return;
        }

        const randomCode = Math.floor(1000 + Math.random() * 9000);
        const codeStr = String(randomCode);
        const expiresAt = now + (2 * 60 * 1000); // 2 minutes

        await codesCol.updateMany(
          { userId: telegramId, used: false },
          { $set: { used: true, reason: "superseded" } }
        );

        await codesCol.insertOne({
          userId: telegramId,
          code: codeStr,
          createdAt: now,
          expiresAt,
          used: false
        });

        const captionText =
          `🔐 <b>HOOCOOH MINER · Verify It's you</b>\n\n` +
          `Here is your secure 4-digit verification code:\n` +
          `👉 <b>Check the image above!</b>\n\n` +
          `⏱ <b>Validity: 2 minutes</b>\n` +
          `<i>Enter this 4-digit code in the app to unlock access. Never share this code.</i>`;

        let sentSuccess = false;
        try {
          const imageBuffer = generateVerificationImage(codeStr);
          const formData = new FormData();
          formData.append("chat_id", telegramId);
          const blob = new Blob([imageBuffer], { type: "image/png" });
          formData.append("photo", blob, `hoocooh_verify_${now}.png`);
          formData.append("caption", captionText);
          formData.append("parse_mode", "HTML");

          const tgRes = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
            method: "POST",
            body: formData
          });
          const tgData = await tgRes.json();
          sentSuccess = tgData && tgData.ok === true;
          if (!sentSuccess) {
            console.warn("sendPhoto by FormData failed:", tgData);
          }
        } catch (photoErr) {
          console.warn("sendPhoto exception:", photoErr.message);
        }

        // Fallback: send text message if sendPhoto fails
        if (!sentSuccess) {
          try {
            await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: telegramId,
                parse_mode: "HTML",
                text:
                  `🔐 <b>HOOCOOH MINER · Verify It's you</b>\n\n` +
                  `Your 4-digit verification code: <code>${codeStr}</code>\n\n` +
                  `⏱ <b>Validity: 2 minutes</b>\n` +
                  `<i>Enter this 4-digit code in the app to unlock access.</i>`
              })
            });
            sentSuccess = true;
          } catch (msgErr) {
            console.error("sendMessage fallback error:", msgErr.message);
          }
        }

        const botUser = await fetchBotUsername(process.env.TELEGRAM_BOT_TOKEN);
        res.status(200).json({
          ok: true,
          expiresAt,
          validitySeconds: 120,
          botUsername: `@${botUser}`,
          message: "A 4-digit code was sent to your Telegram bot."
        });
        return;
      }

      // Verification: Submit 4-digit code
      if (action === "submit_code" || action === "submit_verification_code") {
        const cleanCode = String(code || "").trim();
        if (!/^\d{4}$/.test(cleanCode)) {
          res.status(400).json({ error: "Please enter a valid 4-digit code." });
          return;
        }

        const codesCol = db.collection("user_verification_codes");
        const activeRecord = await codesCol.findOne(
          { userId: telegramId, used: false },
          { sort: { createdAt: -1 } }
        );

        if (!activeRecord) {
          res.status(400).json({ error: "No active verification code found. Please request a new code." });
          return;
        }

        const now = Date.now();
        if (now > activeRecord.expiresAt) {
          await codesCol.updateOne({ _id: activeRecord._id }, { $set: { used: true, reason: "expired" } });
          res.status(400).json({ error: "Verification code has expired (2 minutes limit). Please request a new code." });
          return;
        }

        if (activeRecord.code !== cleanCode) {
          res.status(400).json({ error: "Incorrect verification code! Check the image in @hoocoohmine_bot and try again." });
          return;
        }

        await codesCol.updateOne(
          { _id: activeRecord._id },
          { $set: { used: true, verifiedAt: now } }
        );

        await users.updateOne(
          { _id: user._id },
          { $set: { isIdentityVerified: true, identityVerifiedAt: now } }
        );

        res.status(200).json({
          ok: true,
          verified: true,
          message: "Identity verified successfully!"
        });
        return;
      }

      // Verification: Check status
      if (action === "check_status" || action === "check_verification_status") {
        res.status(200).json({
          ok: true,
          isVerified: user && user.isIdentityVerified === true
        });
        return;
      }

      res.status(400).json({ error: "Unknown action" });
      return;
    }

    // Process Referral if provided and not yet bound
    const rawParam = String(tgUser.start_param || (req.query && req.query.start_param) || "").trim();
    if (rawParam && !user.referredBy) {
      const inviterId = rawParam.replace(/^ref_/, "").trim();
      if (inviterId && /^\d+$/.test(inviterId) && String(inviterId) !== telegramId) {
        const inviter = await findUserById(users, inviterId);
        if (inviter && String(inviter.telegramId) !== telegramId) {
          user.referredBy = String(inviter.telegramId);
          const welcomeBonus = 50; // New recruit gets 50 HOOCOOH
          user.balance = (Number(user.balance) || 0) + welcomeBonus;

          await users.updateOne(
            { _id: user._id },
            { $set: { referredBy: user.referredBy, balance: user.balance } }
          );

          // Reward inviter: +1 recruit, +100 HOOCOOH to earnings and balance
          await users.updateOne(
            { _id: inviter._id },
            {
              $inc: {
                recruitsCount: 1,
                refEarnings: 100,
                balance: 100
              }
            }
          );
        }
      }
    }

    const minerLevel = Math.max(1, Math.min(10, user.minerLevel || 1));
    const minerMultiplier = getMultiplierForLevel(minerLevel);
    const minerLevelName = LEVEL_NAMES[minerLevel - 1] || "Starter";

    const botUsername = await fetchBotUsername(process.env.TELEGRAM_BOT_TOKEN);

    const now = Date.now();
    const CYCLE_MS = 24 * 60 * 60 * 1000;
    let cycleStart = user.adsCycleStartedAt ? Number(user.adsCycleStartedAt) : 0;
    let watchedToday = Number(user.adsWatchedToday || 0);
    let earnedToday = Number(user.adsEarnedToday || 0);

    if (cycleStart && (now - cycleStart >= CYCLE_MS)) {
      watchedToday = 0;
      earnedToday = 0;
      cycleStart = null;
      await users.updateOne({ _id: user._id }, {
        $set: { adsWatchedToday: 0, adsEarnedToday: 0, adsCycleStartedAt: null }
      });
    }

    res.status(200).json({
      telegramId: user.telegramId,
      firstName: user.firstName || tgUser.first_name || "Miner",
      username: user.username || tgUser.username || "",
      photoUrl: user.photoUrl || tgUser.photo_url || "",
      level: minerLevel,
      minerLevel: minerLevel,
      minerMultiplier: minerMultiplier,
      minerLevelName: minerLevelName,
      balance: user.balance,
      lastMineCollectedAt: user.lastMineCollectedAt,
      dailyCycle: user.dailyCycle || 1,
      dailyDayIndex: user.dailyDayIndex || 0,
      lastCheckinAt: user.lastCheckinAt,
      totalDailyEarned: user.totalDailyEarned || 0,
      mineReady: mineIsReady(user.lastMineCollectedAt),
      mineIntervalMs: MINE_INTERVAL_MS,
      dailyStatusNow: dailyStatus(user.lastCheckinAt),
      adsWatchedToday: watchedToday,
      adsEarnedToday: earnedToday,
      adsCycleStartedAt: cycleStart,
      recruitsCount: user.recruitsCount || 0,
      refEarnings: user.refEarnings || 0,
      claimedMilestones: user.claimedMilestones || [],
      language: user.language || "en",
      languageSelected: user.languageSelected === true,
      termsAccepted: user.termsAccepted === true,
      isIdentityVerified: user.isIdentityVerified === true,
      botUsername: botUsername
    });
  } catch (err) {
    console.error("user.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
