const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { findUserById } = require("../lib/userHelper");
const { generateVerificationImage } = require("../lib/verificationImage");

const CODE_VALIDITY_MS = 2 * 60 * 1000; // 2 minutes (120 seconds)
const RESEND_COOLDOWN_MS = 15 * 1000;   // 15 seconds cooldown between requests

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
    res.status(401).json({ error: "Invalid session - please open from Telegram @hoocoohmine_bot" });
    return;
  }

  const uid = String(tgUser.id);
  const { action, code } = req.body || {};

  try {
    const db = await getDb();
    const codesCol = db.collection("user_verification_codes");
    const usersCol = db.collection("users");
    const user = await findUserById(usersCol, uid);

    // ACTION 1: Request a new verification code
    if (action === "request_code") {
      const now = Date.now();

      // Check if user recently requested a code within cooldown
      const recentCode = await codesCol.findOne(
        { userId: uid, used: false },
        { sort: { createdAt: -1 } }
      );

      if (recentCode && (now - recentCode.createdAt < RESEND_COOLDOWN_MS)) {
        const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (now - recentCode.createdAt)) / 1000);
        res.status(429).json({
          error: `Please wait ${waitSec}s before requesting a new code.`
        });
        return;
      }

      // Generate random 4-digit code (1000 - 9999)
      const randomCode = Math.floor(1000 + Math.random() * 9000);
      const codeStr = String(randomCode);
      const expiresAt = now + CODE_VALIDITY_MS;

      // Invalidate any older unused codes for this user
      await codesCol.updateMany(
        { userId: uid, used: false },
        { $set: { used: true, reason: "superseded" } }
      );

      // Save new code to MongoDB
      await codesCol.insertOne({
        userId: uid,
        code: codeStr,
        createdAt: now,
        expiresAt,
        used: false
      });

      // Build base URL for dynamic image access
      const protocol = req.headers["x-forwarded-proto"] || "https";
      const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
      const baseUrl = `${protocol}://${host}`;
      const photoUrl = `${baseUrl}/api/verify-image?code=${codeStr}&t=${now}`;

      const captionText =
        `🔐 <b>HOOCOOH MINER · Verify It's you</b>\n\n` +
        `Here is your secure 4-digit verification code:\n` +
        `👉 <b>Check the image above!</b>\n\n` +
        `⏱ <b>Validity: 2 minutes</b>\n` +
        `<i>Enter this 4-digit code in the app to unlock access. Never share this code.</i>`;

      // Method 1: Send via URL to Telegram API
      let sentSuccess = false;
      try {
        const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: uid,
            photo: photoUrl,
            caption: captionText,
            parse_mode: "HTML"
          })
        });
        const tgData = await tgRes.json();
        sentSuccess = tgData && tgData.ok === true;
        if (!sentSuccess) {
          console.warn("sendPhoto by URL failed:", tgData);
        }
      } catch (tgUrlErr) {
        console.warn("sendPhoto by URL exception:", tgUrlErr.message);
      }

      // Method 2: If URL failed, try multipart FormData with Blob
      if (!sentSuccess) {
        try {
          const formData = new FormData();
          formData.append("chat_id", uid);
          const blob = new Blob([imageBuffer], { type: "image/png" });
          formData.append("photo", blob, `hoocooh_verify_${now}.png`);
          formData.append("caption", captionText);
          formData.append("parse_mode", "HTML");

          const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
            method: "POST",
            body: formData
          });
          const tgData = await tgRes.json();
          sentSuccess = tgData && tgData.ok === true;
        } catch (tgFormErr) {
          console.warn("sendPhoto by FormData exception:", tgFormErr.message);
        }
      }

      // Method 3: If both photo methods fail, send code as text message
      if (!sentSuccess) {
        try {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: uid,
              parse_mode: "HTML",
              text:
                `🔐 <b>HOOCOOH MINER · Verify It's you</b>\n\n` +
                `Your 4-digit verification code: <code>${codeStr}</code>\n\n` +
                `⏱ <b>Validity: 2 minutes</b>\n` +
                `<i>Enter this 4-digit code in the app to unlock access.</i>`
            })
          });
          sentSuccess = true;
        } catch (fallbackErr) {
          console.error("Telegram sendMessage fallback error:", fallbackErr.message);
        }
      }

      res.status(200).json({
        ok: true,
        expiresAt,
        validitySeconds: 120,
        botUsername: "@hoocoohmine_bot",
        message: "A 4-digit code image was sent to @hoocoohmine_bot."
      });
      return;
    }

    // ACTION 2: Submit and verify 4-digit code
    if (action === "submit_code") {
      const cleanCode = String(code || "").trim();
      if (!/^\d{4}$/.test(cleanCode)) {
        res.status(400).json({ error: "Please enter a valid 4-digit code." });
        return;
      }

      const activeRecord = await codesCol.findOne(
        { userId: uid, used: false },
        { sort: { createdAt: -1 } }
      );

      if (!activeRecord) {
        res.status(400).json({ error: "No active verification code found. Please request a new code." });
        return;
      }

      const now = Date.now();
      if (now > activeRecord.expiresAt) {
        await codesCol.updateOne({ _id: activeRecord._id }, { $set: { used: true, reason: "expired" } });
        res.status(400).json({ error: "Verification code has expired (2 minutes limit). Please request a new code." });
        return;
      }

      if (activeRecord.code !== cleanCode) {
        res.status(400).json({ error: "Incorrect verification code! Check the image in @hoocoohmine_bot and try again." });
        return;
      }

      // Mark code as used immediately
      await codesCol.updateOne(
        { _id: activeRecord._id },
        { $set: { used: true, verifiedAt: now } }
      );

      // Mark user as verified in MongoDB
      if (user) {
        await usersCol.updateOne(
          { _id: user._id },
          { $set: { isIdentityVerified: true, identityVerifiedAt: now } }
        );
      }

      res.status(200).json({
        ok: true,
        verified: true,
        message: "Identity verified successfully!"
      });
      return;
    }

    // ACTION 3: Check verification status
    if (action === "check_status") {
      const isVerified = user && user.isIdentityVerified === true;
      res.status(200).json({
        ok: true,
        isVerified: !!isVerified
      });
      return;
    }

    res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error("verify-code.js error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
};
