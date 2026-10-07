const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { findOrCreateUser } = require("../lib/userHelper");
const crypto = require("crypto");

const COIN_RATE = 0.00004; // 1 HOOCOOH = 0.00004 USDT
// Conversion rate: 3 cents ($0.03 USD) = 0.019 TON
// TON per USD = 0.019 / 0.03 = 19 / 30 (~0.63333333 TON per $1 USDT)
const TON_PER_USD = 0.019 / 0.03;

module.exports = async (req, res) => {
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
    const withdrawalsCol = db.collection("withdrawals");

    let user = await findOrCreateUser(usersCol, tgUser);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (user.isBanned) {
      res.status(403).json({ error: "Your account has been suspended" });
      return;
    }

    // 1. GET: Fetch wallet summary and transaction history
    if (req.method === "GET") {
      const txs = await withdrawalsCol
        .find({ telegramId })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();

      const mappedTxs = txs.map(t => ({
        id: String(t._id),
        amount: t.amount,
        usdtAmount: t.usdtAmount,
        walletAddress: t.walletAddress,
        network: t.network || "USDT",
        status: t.status || "PENDING",
        txHash: t.txHash || "",
        createdAt: t.createdAt
      }));

      const recruits = Number(user.recruitsCount || 0);
      const balance = Number(user.balance || 0);
      const usdtEquivalent = Number((balance * COIN_RATE).toFixed(2));

      res.status(200).json({
        ok: true,
        balance,
        usdtEquivalent,
        coinRate: COIN_RATE,
        recruitsCount: recruits,
        totalMined: Math.round(balance + (Number(user.totalDailyEarned) || 0) + (Number(user.refEarnings) || 0)),
        transactions: mappedTxs
      });
      return;
    }

    // 2. POST: Process withdrawal
    if (req.method === "POST") {
      const { action, amount, walletAddress, network } = req.body || {};

      if (action === "withdraw") {
        const numAmount = parseInt(amount, 10);
        if (isNaN(numAmount) || numAmount < 100) {
          res.status(400).json({ error: "Minimum withdrawal amount is 100 HOOCOOH Coins" });
          return;
        }

        const currentBal = Number(user.balance || 0);
        if (currentBal < numAmount) {
          res.status(400).json({
            error: `Insufficient balance! Current: ${currentBal.toLocaleString()} Coins. Requested: ${numAmount.toLocaleString()} Coins.`
          });
          return;
        }

        const cleanAddress = (walletAddress || "").trim();
        const isTon = /^(UQ|EQ|kQ|0Q)[A-Za-z0-9_-]{46}$/.test(cleanAddress) || /^(-1|0):[0-9a-fA-F]{64}$/.test(cleanAddress);
        if (!isTon) {
          res.status(400).json({ error: "Invalid TON address! Address must be 48 characters starting with UQ or EQ" });
          return;
        }
        const usdtVal = Number((numAmount * COIN_RATE).toFixed(4));
        const tonVal = Number((usdtVal * TON_PER_USD).toFixed(6));
        const newBal = currentBal - numAmount;
        const now = Date.now();

        // Deduct from user balance
        await usersCol.updateOne(
          { _id: user._id },
          { $set: { balance: newBal } }
        );

        // Record withdrawal transaction in MongoDB with PENDING status
        const txDoc = {
          telegramId,
          amount: numAmount,
          usdtAmount: usdtVal,
          tonAmount: tonVal,
          walletAddress: cleanAddress,
          network: "TON",
          status: "PENDING",
          txHash: "",
          createdAt: now
        };

        const insertRes = await withdrawalsCol.insertOne(txDoc);

        res.status(200).json({
          ok: true,
          message: `⏳ Withdrawal request of ${numAmount.toLocaleString()} Coins ($${usdtVal.toFixed(2)} USDT) submitted for review!`,
          newBalance: newBal,
          transaction: {
            id: String(insertRes.insertedId),
            ...txDoc
          }
        });
        return;
      }

      res.status(400).json({ error: "Unknown action" });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("wallet.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
