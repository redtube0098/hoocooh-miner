const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { dailyStatus, rewardForCycleDay } = require("../lib/gameLogic");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

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
    const user = await users.findOne({ telegramId });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
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

    res.status(200).json({
      balance: newBalance,
      dailyCycle,
      dailyDayIndex,
      lastCheckinAt: now,
      totalDailyEarned: newTotal,
      reward
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};
