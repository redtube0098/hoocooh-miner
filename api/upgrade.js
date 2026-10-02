const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { LEVEL_NAMES, getMultiplierForLevel, getUpgradeCostForLevel } = require("../lib/gameLogic");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    res.status(500).json({ error: "TELEGRAM_BOT_TOKEN is not configured" });
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
      res.status(404).json({ error: "User not found" });
      return;
    }

    const currentLevel = Math.max(1, Math.min(10, user.minerLevel || 1));
    if (currentLevel >= 10) {
      res.status(400).json({ error: "Your miner is already at the maximum level (Level 10 Transcendent)!" });
      return;
    }

    const cost = getUpgradeCostForLevel(currentLevel);
    if (!cost) {
      res.status(400).json({ error: "Upgrade cost not defined" });
      return;
    }

    const userBal = Number(user.balance || 0);
    if (userBal < cost) {
      res.status(400).json({
        error: `Insufficient balance! You need ${cost.toLocaleString()} HOOCOOH Coins to upgrade to Level ${currentLevel + 1}. Current balance: ${userBal.toLocaleString()}`
      });
      return;
    }

    const newLevel = currentLevel + 1;
    const newBal = userBal - cost;

    await users.updateOne(
      { telegramId },
      { $set: { balance: newBal, minerLevel: newLevel } }
    );

    const newMultiplier = getMultiplierForLevel(newLevel);
    const newName = LEVEL_NAMES[newLevel - 1] || "Miner";

    res.status(200).json({
      ok: true,
      minerLevel: newLevel,
      level: newLevel,
      balance: newBal,
      multiplier: newMultiplier,
      levelName: newName,
      message: `🎉 Upgraded to Level ${newLevel} ${newName}! Reward multiplier is now ${newMultiplier}x.`
    });
  } catch (err) {
    console.error("upgrade.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
