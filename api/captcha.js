const crypto = require("crypto");
const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");

const CHALLENGE_EXPIRY_MS = 120 * 1000; // 2 minutes
const TOKEN_EXPIRY_MS = 90 * 1000;      // 90 seconds

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
    const usersCol = db.collection("users");
    const challengesCol = db.collection("captcha_challenges");
    const tokensCol = db.collection("captcha_tokens");

    // 1. Strict Security Check: Banned / Suspended Accounts are denied immediately
    let user = await usersCol.findOne({
      $or: [{ telegramId: uid }, { telegramId: Number(uid) }]
    });

    if (user && user.isBanned) {
      res.status(403).json({
        error: user.banReason || "Your account has been permanently suspended due to security violation.",
        isBanned: true
      });
      return;
    }

    const now = Date.now();

    // Helper to permanently suspend account on automated tamper / bypass detection
    async function triggerPermanentBan(reason) {
      const banReason = `Permanent suspension: ${reason}`;
      if (user) {
        await usersCol.updateOne(
          { _id: user._id },
          {
            $set: {
              isBanned: true,
              bannedAt: now,
              banReason
            }
          }
        );
      } else {
        await usersCol.updateOne(
          { telegramId: uid },
          {
            $set: {
              isBanned: true,
              bannedAt: now,
              banReason
            }
          },
          { upsert: true }
        );
      }
    }

    // Action 1: Create a fresh challenge
    if (action === "create") {
      const challengeId = crypto.randomBytes(16).toString("hex");
      // Puzzle canvas is 320px wide. Valid slot range between 80px and 230px.
      const targetX = Math.floor(Math.random() * (230 - 80 + 1)) + 80;
      const targetY = Math.floor(Math.random() * (85 - 25 + 1)) + 25;

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

      // Attack / Replay detection:
      if (!challenge) {
        const strikes = Number(user && user.captchaStrikes ? user.captchaStrikes : 0) + 1;
        if (strikes >= 4) {
          await triggerPermanentBan("Repeated automated challenge replay / brute force attempts");
          res.status(403).json({
            error: "Your account has been permanently suspended due to automated bypass attempts.",
            isBanned: true
          });
          return;
        }
        if (user) {
          await usersCol.updateOne({ _id: user._id }, { $set: { captchaStrikes: strikes } });
        }
        res.status(400).json({ error: "Invalid or expired challenge. Please try again." });
        return;
      }

      // Mark challenge as used immediately to prevent replay attacks
      await challengesCol.updateOne(
        { _id: challenge._id },
        { $set: { used: true, verifiedAt: now } }
      );

      if (now - challenge.createdAt > CHALLENGE_EXPIRY_MS) {
        res.status(400).json({ error: "Challenge expired. Please try again." });
        return;
      }

      const elapsed = Number(timeElapsed) || 0;

      // 1. Anti-Bot: Instant scripts & 2Captcha auto-solvers click in < 220ms
      if (elapsed < 220) {
        const strikes = Number(user && user.captchaStrikes ? user.captchaStrikes : 0) + 1;
        if (strikes >= 3) {
          await triggerPermanentBan("Sub-human reaction time / automated solver detected");
          res.status(403).json({
            error: "Your account has been permanently suspended due to automated bot activity.",
            isBanned: true
          });
          return;
        }
        if (user) await usersCol.updateOne({ _id: user._id }, { $set: { captchaStrikes: strikes } });
        res.status(400).json({ error: "Solving too fast. Please slide naturally." });
        return;
      }

      // 2. Trajectory & Trail Analysis: Bots provide empty, single, or spoofed trail
      if (!Array.isArray(trail) || trail.length < 3) {
        const strikes = Number(user && user.captchaStrikes ? user.captchaStrikes : 0) + 1;
        if (strikes >= 3) {
          await triggerPermanentBan("Synthetic touch event / headless script tampering detected");
          res.status(403).json({
            error: "Your account has been permanently suspended due to automated script tampering.",
            isBanned: true
          });
          return;
        }
        if (user) await usersCol.updateOne({ _id: user._id }, { $set: { captchaStrikes: strikes } });
        res.status(400).json({ error: "Natural touch trajectory required. Please slide naturally." });
        return;
      }

      // 3. Tolerance Check: puzzle piece placed nearby (relaxed to ±22 pixels for smooth human UX)
      const diff = Math.abs(solvedX - challenge.targetX);
      if (diff > 22) {
        const failCount = Number(user && user.captchaFailures ? user.captchaFailures : 0) + 1;
        if (failCount >= 8) {
          await triggerPermanentBan("Excessive rapid puzzle failures / automated solver spam");
          res.status(403).json({
            error: "Your account has been permanently suspended due to excessive failed attempts.",
            isBanned: true
          });
          return;
        }
        if (user) await usersCol.updateOne({ _id: user._id }, { $set: { captchaFailures: failCount } });
        res.status(400).json({
          error: "Puzzle piece did not fit into place. Try again.",
          diff
        });
        return;
      }

      // All security checks passed! Reset suspicious strikes and issue cryptographically secure token
      if (user) {
        await usersCol.updateOne(
          { _id: user._id },
          { $set: { captchaStrikes: 0, captchaFailures: 0 } }
        );
      }

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
