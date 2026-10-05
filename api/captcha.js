const crypto = require("crypto");
const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");

const CHALLENGE_EXPIRY_MS = 120 * 1000; // 2 minutes
const TOKEN_EXPIRY_MS = 60 * 1000;      // 1 minute

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

  const { action } = req.body || {};

  const uid = String(tgUser.id);

  try {
    const db = await getDb();
    const challengesCol = db.collection("captcha_challenges");
    const tokensCol = db.collection("captcha_tokens");

    // Action 1: Create a fresh challenge
    if (action === "create") {
      const challengeId = crypto.randomBytes(16).toString("hex");
      // Puzzle canvas is typically 320px wide. Valid slot range between 80px and 230px.
      const targetX = Math.floor(Math.random() * (230 - 80 + 1)) + 80;
      const targetY = Math.floor(Math.random() * (85 - 25 + 1)) + 25;
      const now = Date.now();

      await challengesCol.insertOne({
        challengeId,
        userId: uid,
        targetX,
        targetY,
        createdAt: now,
        used: false
      });

      res.status(200).json({
        ok: true,
        challengeId,
        targetX,
        targetY
      });
      return;
    }

    // Action 2: Verify the user's solved slider position
    if (action === "verify") {
      const { challengeId, solvedX, timeElapsed, trail } = req.body || {};

      if (!challengeId || typeof solvedX !== "number") {
        res.status(400).json({ error: "Missing verification parameters" });
        return;
      }

      const challenge = await challengesCol.findOne({
        challengeId,
        userId: { $in: [uid, Number(uid), tgUser.id] },
        used: false
      });

      if (!challenge) {
        res.status(400).json({ error: "Invalid or already used challenge. Please try again." });
        return;
      }

      // Mark challenge as used immediately to prevent replay
      await challengesCol.updateOne(
        { _id: challenge._id },
        { $set: { used: true, verifiedAt: Date.now() } }
      );

      const now = Date.now();
      if (now - challenge.createdAt > CHALLENGE_EXPIRY_MS) {
        res.status(400).json({ error: "Challenge expired. Please try again." });
        return;
      }

      // 1. Anti-Bot Check: Instant automated scripts take 0-100ms
      const elapsed = Number(timeElapsed) || 0;
      if (elapsed < 200) {
        res.status(400).json({ error: "Solving too fast. Please slide naturally." });
        return;
      }

      // 2. Tolerance Check: puzzle piece placed nearby (relaxed to ±20 pixels for easy UX)
      const diff = Math.abs(solvedX - challenge.targetX);
      if (diff > 20) {
        res.status(400).json({
          error: "Puzzle piece did not fit into place. Try again.",
          diff
        });
        return;
      }

      // All checks passed! Issue a single-use cryptographically random token
      const captchaToken = crypto.randomBytes(24).toString("hex");
      await tokensCol.insertOne({
        token: captchaToken,
        userId: uid,
        createdAt: now,
        used: false
      });

      res.status(200).json({
        ok: true,
        captchaToken,
        message: "Verification successful!"
      });
      return;
    }

    res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error("captcha.js error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
};
