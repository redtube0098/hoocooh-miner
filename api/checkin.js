const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { findOrCreateUser } = require("../lib/userHelper");
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

    let dailyCycle = Number(user.dailyCycle) || 1;
    let dailyDayIndex = Number(user.dailyDayIndex) || 0;

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
      level: user.minerLevel || 1
    });
  } catch (err) {
    console.error("checkin.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
