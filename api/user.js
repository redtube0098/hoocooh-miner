const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { mineIsReady, dailyStatus, MINE_INTERVAL_MS } = require("../lib/gameLogic");

function defaultUser(telegramId) {
  return {
    telegramId,
    balance: 0,
    lastMineCollectedAt: null,
    dailyCycle: 1,
    dailyDayIndex: 0,
    lastCheckinAt: null,
    totalDailyEarned: 0,
    createdAt: Date.now()
  };
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // The frontend sends Telegram's raw, signed initData string on every
  // request. We verify it here with the bot token (server-side only,
  // set in Vercel env vars) - a request with no valid initData is
  // rejected, so the app only ever works when opened from Telegram.
  const initData = req.headers["x-telegram-init-data"];
  const tgUser = validateInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
  if (!tgUser) {
    res.status(401).json({ error: "This app can only be opened from Telegram." });
    return;
  }
  const telegramId = String(tgUser.id);

  try {
    const db = await getDb();
    const users = db.collection("users");

    let user = await users.findOne({ telegramId });
    if (!user) {
      user = defaultUser(telegramId);
      user.firstName = tgUser.first_name || "";
      user.username = tgUser.username || "";
      user.photoUrl = tgUser.photo_url || "";
      await users.insertOne(user);
    } else {
      const updateFields = {};
      if (tgUser.first_name && user.firstName !== tgUser.first_name) {
        updateFields.firstName = tgUser.first_name;
        user.firstName = tgUser.first_name;
      }
      if (tgUser.username && user.username !== tgUser.username) {
        updateFields.username = tgUser.username;
        user.username = tgUser.username;
      }
      if (tgUser.photo_url && user.photoUrl !== tgUser.photo_url) {
        updateFields.photoUrl = tgUser.photo_url;
        user.photoUrl = tgUser.photo_url;
      }
      if (Object.keys(updateFields).length > 0) {
        await users.updateOne({ telegramId }, { $set: updateFields });
      }
    }

    const currentLevel = Math.max(1, Math.floor((user.balance || 0) / 1000) + 1);

    res.status(200).json({
      telegramId: user.telegramId,
      firstName: user.firstName || tgUser.first_name || "Miner",
      username: user.username || tgUser.username || "",
      photoUrl: user.photoUrl || tgUser.photo_url || "",
      level: currentLevel,
      balance: user.balance,
      lastMineCollectedAt: user.lastMineCollectedAt,
      dailyCycle: user.dailyCycle,
      dailyDayIndex: user.dailyDayIndex,
      lastCheckinAt: user.lastCheckinAt,
      totalDailyEarned: user.totalDailyEarned,
      mineReady: mineIsReady(user.lastMineCollectedAt),
      mineIntervalMs: MINE_INTERVAL_MS,
      dailyStatusNow: dailyStatus(user.lastCheckinAt)
    });
  } catch (err) {
    console.error("user.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
