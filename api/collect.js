const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { findOrCreateUser } = require("../lib/userHelper");
const { mineIsReady, MINE_REWARD, getMultiplierForLevel } = require("../lib/gameLogic");

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

  try {
    const db = await getDb();
    const users = db.collection("users");
    let user = await findOrCreateUser(users, tgUser);

    if (user && user.isBanned) {
      res.status(403).json({ error: "Your account has been suspended" });
      return;
    }

    if (!mineIsReady(user.lastMineCollectedAt)) {
      res.status(400).json({ error: "Not ready yet", mineReady: false });
      return;
    }

    const minerLevel = Math.max(1, Math.min(10, user.minerLevel || 1));
    const multiplier = getMultiplierForLevel(minerLevel);
    const reward = Math.round(MINE_REWARD * multiplier);

    const now = Date.now();
    const newBalance = (Number(user.balance) || 0) + reward;

    await users.updateOne(
      { _id: user._id },
      { $set: { balance: newBalance, lastMineCollectedAt: now } }
    );

    res.status(200).json({
      balance: newBalance,
      lastMineCollectedAt: now,
      reward: reward,
      multiplier: multiplier,
      minerLevel: minerLevel,
      level: minerLevel
    });
  } catch (err) {
    console.error("collect.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
