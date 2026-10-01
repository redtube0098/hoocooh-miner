const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { dailyStatus, rewardForCycleDay } = require("../lib/gameLogic");

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
    let user = await users.findOne({ telegramId });

    if (!user) {
      user = {
        telegramId,
        firstName: tgUser.first_name || "",
        username: tgUser.username || "",
        photoUrl: tgUser.photo_url || "",
        balance: 0,
        lastMineCollectedAt: null,
        dailyCycle: 1,
        dailyDayIndex: 0,
        lastCheckinAt: null,
        totalDailyEarned: 0,
        createdAt: Date.now()
      };
      await users.insertOne(user);
    }

    const status = dailyStatus(user.lastCheckinAt);
    if (status === "waiting") {
      res.status(400).json({ error: "Already checked in today", status });
      return;
    }

    let { dailyCycle, dailyDayIndex } = user;

    if (status === "broken") {
      dailyDayIndex = 0;
    } else if (user.lastCheckinAt) {
      dailyDayIndex += 1;
      if (dailyDayIndex > 6) {
        dailyDayIndex = 0;
        dailyCycle = Math.max(2, dailyCycle + 1);
      }
    }

    const reward = rewardForCycleDay(dailyCycle, dailyDayIndex);
    const now = Date.now();
    const newBalance = user.balance + reward;
    const newTotal = (user.totalDailyEarned || 0) + reward;

    await users.updateOne(
      { telegramId },
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

    const currentLevel = Math.max(1, Math.floor(newBalance / 1000) + 1);
    res.status(200).json({
      balance: newBalance,
      dailyCycle,
      dailyDayIndex,
      lastCheckinAt: now,
      totalDailyEarned: newTotal,
      reward,
      level: currentLevel
    });
  } catch (err) {
    console.error("checkin.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
