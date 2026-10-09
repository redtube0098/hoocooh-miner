const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { findOrCreateUser } = require("../lib/userHelper");
const { dailyStatus, rewardForCycleDay } = require("../lib/gameLogic");
const { verifyActionToken, createActionToken } = require("../lib/actionSigner");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
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
  const uid = String(tgUser.id);

  try {
    const db = await getDb();
    const users = db.collection("users");
    let user = await findOrCreateUser(users, tgUser);

    if (user && user.isBanned) {
      res.status(403).json({ error: "Your account has been suspended" });
      return;
    }

    const status = dailyStatus(user.lastCheckinAt);
    if (status === "waiting") {
      res.status(400).json({ error: "Already checked in today", status });
      return;
    }

    // 1. Puzzle Captcha Verification (Required after watching Monetag Ad)
    const { captchaToken } = req.body || {};
    if (!captchaToken) {
      res.status(400).json({ error: "Security puzzle verification required! Please solve the puzzle." });
      return;
    }

    const tokensCol = db.collection("captcha_tokens");
    const tokenDoc = await tokensCol.findOne({
      token: String(captchaToken),
      userId: { $in: [uid, Number(uid), tgUser.id] },
      used: false
    });

    if (!tokenDoc) {
      res.status(400).json({ error: "Invalid or expired verification. Please solve the puzzle again." });
      return;
    }

    // Burn token
    await tokensCol.updateOne(
      { _id: tokenDoc._id },
      { $set: { used: true, usedAt: Date.now() } }
    );

    // 2. Cryptographic Action Signing Verification
    const actionToken = (req.body && req.body.actionToken) || req.headers["x-action-token"] || req.headers["x-action-signature"] || req.headers["x-action-secret"];
    if (!verifyActionToken(uid, "checkin", actionToken)) {
      res.status(403).json({ error: "Security check failed: Invalid or missing action signature token." });
      return;
    }

    let dailyCycle = Number(user.dailyCycle) || 1;
    let dailyDayIndex = Number(user.dailyDayIndex) || 0;

    if (status === "broken") {
      dailyDayIndex = 0;
      dailyCycle = 1;
    } else if (user.lastCheckinAt) {
      dailyDayIndex += 1;
      if (dailyDayIndex > 6) {
        dailyDayIndex = 0;
        dailyCycle = Math.max(2, dailyCycle + 1);
      }
    }

    const reward = rewardForCycleDay(dailyCycle, dailyDayIndex);
    const now = Date.now();
    const newBalance = (Number(user.balance) || 0) + reward;
    const newTotal = (Number(user.totalDailyEarned) || 0) + reward;

    await users.updateOne(
      { _id: user._id },
      {
        $set: {
          balance: newBalance,
          dailyCycle,
          dailyDayIndex,
          lastCheckinAt: now,
          totalDailyEarned: newTotal
        }
      }
    );

    res.status(200).json({
      balance: newBalance,
      dailyCycle,
      dailyDayIndex,
      lastCheckinAt: now,
      totalDailyEarned: newTotal,
      reward,
      level: user.minerLevel || 1,
      newActionToken: createActionToken(uid, "checkin")
    });
  } catch (err) {
    console.error("checkin.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
