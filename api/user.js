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
      await users.insertOne(user);
    }

    res.status(200).json({
      telegramId: user.telegramId,
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
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};
