const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { findOrCreateUser } = require("../lib/userHelper");
const { mineIsReady, MINE_REWARD, getMultiplierForLevel } = require("../lib/gameLogic");
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
  const telegramId = String(tgUser.id);

  try {
    const db = await getDb();
    const users = db.collection("users");
    let user = await findOrCreateUser(users, tgUser);

    if (user && user.isBanned) {
      res.status(403).json({ error: "Your account has been suspended" });
      return;
    }

    // Cryptographic Action Signing Verification
    const actionToken = (req.body && req.body.actionToken) || req.headers["x-action-token"] || req.headers["x-action-signature"] || req.headers["x-action-secret"];
    if (!verifyActionToken(telegramId, "mine", actionToken)) {
      res.status(403).json({ error: "Security check failed: Invalid or missing action signature token." });
      return;
    }

    if (!mineIsReady(user.lastMineCollectedAt)) {
      res.status(400).json({ error: "Not ready yet", mineReady: false });
      return;
    }

    const { captchaToken } = req.body || {};
    if (!captchaToken) {
      res.status(400).json({ error: "Puzzle verification required! Please complete the captcha to start mining." });
      return;
    }

    const tokensCol = db.collection("captcha_tokens");
    const uid = String(tgUser.id);
    const tokenDoc = await tokensCol.findOne({
      token: String(captchaToken),
      userId: { $in: [uid, Number(uid), tgUser.id] },
      used: false
    });

    if (!tokenDoc) {
      res.status(400).json({ error: "Invalid or expired verification token. Please verify again." });
      return;
    }

    // Mark single-use token as used immediately
    await tokensCol.updateOne(
      { _id: tokenDoc._id },
      { $set: { used: true, usedAt: Date.now() } }
    );

    const minerLevel = Math.max(1, Math.min(10, user.minerLevel || 1));
    const multiplier = getMultiplierForLevel(minerLevel);
    const reward = Math.round(MINE_REWARD * multiplier);

    const now = Date.now();
    const newBalance = (Number(user.balance) || 0) + reward;

    await users.updateOne(
      { _id: user._id },
      { $set: { balance: newBalance, lastMineCollectedAt: now, mineReminderSent: false } }
    );

    res.status(200).json({
      balance: newBalance,
      lastMineCollectedAt: now,
      reward: reward,
      multiplier: multiplier,
      minerLevel: minerLevel,
      level: minerLevel,
      newActionToken: createActionToken(telegramId, "mine")
    });
  } catch (err) {
    console.error("collect.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
