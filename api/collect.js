const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { mineIsReady, MINE_REWARD } = require("../lib/gameLogic");

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

    if (!mineIsReady(user.lastMineCollectedAt)) {
      res.status(400).json({ error: "Not ready yet", mineReady: false });
      return;
    }

    const now = Date.now();
    const newBalance = user.balance + MINE_REWARD;

    await users.updateOne(
      { telegramId },
      { $set: { balance: newBalance, lastMineCollectedAt: now } }
    );

    res.status(200).json({
      balance: newBalance,
      lastMineCollectedAt: now,
      reward: MINE_REWARD
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};
