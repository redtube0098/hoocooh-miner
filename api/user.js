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
    recruitsCount: 0,
    refEarnings: 0,
    referredBy: null,
    claimedMilestones: [],
    createdAt: Date.now()
  };
}

let cachedBotUsername = null;
async function fetchBotUsername(token) {
  if (cachedBotUsername) return cachedBotUsername;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json();
    if (data.ok && data.result && data.result.username) {
      cachedBotUsername = data.result.username;
      return cachedBotUsername;
    }
  } catch(e) {}
  return "hoocooh_miner_bot";
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
    const isNew = !user;
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

    // Process Referral if provided and not yet bound
    const startParam = tgUser.start_param || (req.query && req.query.start_param) || "";
    if (startParam && startParam.startsWith("ref_") && !user.referredBy) {
      const inviterId = startParam.replace(/^ref_/, "").trim();
      if (inviterId && inviterId !== telegramId) {
        const inviter = await users.findOne({ telegramId: inviterId });
        if (inviter) {
          user.referredBy = inviterId;
          const welcomeBonus = 50; // New user gets 50 HOOCOOH
          user.balance = (user.balance || 0) + welcomeBonus;

          await users.updateOne(
            { telegramId },
            { $set: { referredBy: inviterId, balance: user.balance } }
          );

          // Reward inviter: +1 recruit, +100 HOOCOOH, +100 to balance
          await users.updateOne(
            { telegramId: inviterId },
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

    const { LEVEL_NAMES, getMultiplierForLevel } = require("../lib/gameLogic");
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
      await users.updateOne({ telegramId }, {
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
      dailyCycle: user.dailyCycle,
      dailyDayIndex: user.dailyDayIndex,
      lastCheckinAt: user.lastCheckinAt,
      totalDailyEarned: user.totalDailyEarned,
      mineReady: mineIsReady(user.lastMineCollectedAt),
      mineIntervalMs: MINE_INTERVAL_MS,
      dailyStatusNow: dailyStatus(user.lastCheckinAt),
      adsWatchedToday: watchedToday,
      adsEarnedToday: earnedToday,
      adsCycleStartedAt: cycleStart,
      recruitsCount: user.recruitsCount || 0,
      refEarnings: user.refEarnings || 0,
      claimedMilestones: user.claimedMilestones || [],
      botUsername: botUsername
    });
  } catch (err) {
    console.error("user.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
