const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { findOrCreateUser, findUserById } = require("../lib/userHelper");
const { mineIsReady, dailyStatus, MINE_INTERVAL_MS, LEVEL_NAMES, getMultiplierForLevel } = require("../lib/gameLogic");

let cachedBotUsername = null;
async function fetchBotUsername(token) {
  if (cachedBotUsername) return cachedBotUsername;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: controller.signal });
    clearTimeout(timeout);
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

    // Unified user retrieval, multi-type ID lookup, and duplicate merge
    let user = await findOrCreateUser(users, tgUser);

    if (user && user.isBanned) {
      res.status(200).json({
        isBanned: true,
        banReason: user.banReason || "Your account has been suspended",
        telegramId: user.telegramId
      });
      return;
    }

    // Process Referral if provided and not yet bound
    const rawParam = String(tgUser.start_param || (req.query && req.query.start_param) || "").trim();
    if (rawParam && !user.referredBy) {
      const inviterId = rawParam.replace(/^ref_/, "").trim();
      if (inviterId && /^\d+$/.test(inviterId) && String(inviterId) !== telegramId) {
        const inviter = await findUserById(users, inviterId);
        if (inviter && String(inviter.telegramId) !== telegramId) {
          user.referredBy = String(inviter.telegramId);
          const welcomeBonus = 50; // New recruit gets 50 HOOCOOH
          user.balance = (Number(user.balance) || 0) + welcomeBonus;

          await users.updateOne(
            { _id: user._id },
            { $set: { referredBy: user.referredBy, balance: user.balance } }
          );

          // Reward inviter: +1 recruit, +100 HOOCOOH to earnings and balance
          await users.updateOne(
            { _id: inviter._id },
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
      await users.updateOne({ _id: user._id }, {
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
      dailyCycle: user.dailyCycle || 1,
      dailyDayIndex: user.dailyDayIndex || 0,
      lastCheckinAt: user.lastCheckinAt,
      totalDailyEarned: user.totalDailyEarned || 0,
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
