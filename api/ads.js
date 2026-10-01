const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");

const MAX_ADS_PER_DAY = 12;
const AD_REWARD = 20;
const CYCLE_MS = 24 * 60 * 60 * 1000;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    res.status(500).json({ error: "TELEGRAM_BOT_TOKEN is not configured" });
    return;
  }

  const initData = req.headers["x-telegram-init-data"];
  const tgUser = validateInitData(initData, botToken);
  if (!tgUser) {
    res.status(401).json({ error: "Invalid session - reopen app from Telegram" });
    return;
  }
  const telegramId = String(tgUser.id);

  try {
    const db = await getDb();
    const usersCol = db.collection("users");

    let user = await usersCol.findOne({ telegramId });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const now = Date.now();
    let cycleStart = user.adsCycleStartedAt ? Number(user.adsCycleStartedAt) : 0;
    let watchedToday = Number(user.adsWatchedToday || 0);
    let earnedToday = Number(user.adsEarnedToday || 0);

    // If 24 hours passed since cycle start, reset
    if (!cycleStart || (now - cycleStart >= CYCLE_MS)) {
      watchedToday = 0;
      earnedToday = 0;
      cycleStart = now;
    }

    // Check if 12 ads already watched
    if (watchedToday >= MAX_ADS_PER_DAY) {
      const remainingMs = Math.max(0, CYCLE_MS - (now - cycleStart));
      res.status(400).json({
        error: "Daily limit of 12 ads reached! Next ads available in 24 hours.",
        remainingMs: remainingMs,
        adsWatchedToday: watchedToday,
        adsEarnedToday: earnedToday,
        adsCycleStartedAt: cycleStart
      });
      return;
    }

    watchedToday += 1;
    earnedToday += AD_REWARD;
    const newBalance = Number(user.balance || 0) + AD_REWARD;

    await usersCol.updateOne(
      { telegramId },
      {
        $set: {
          balance: newBalance,
          adsWatchedToday: watchedToday,
          adsEarnedToday: earnedToday,
          adsCycleStartedAt: cycleStart
        }
      }
    );

    res.status(200).json({
      ok: true,
      reward: AD_REWARD,
      newBalance: newBalance,
      adsWatchedToday: watchedToday,
      adsEarnedToday: earnedToday,
      adsCycleStartedAt: cycleStart,
      remainingToday: MAX_ADS_PER_DAY - watchedToday,
      maxAds: MAX_ADS_PER_DAY
    });
  } catch (err) {
    console.error("ads.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
