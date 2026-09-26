const crypto = require("crypto");

// Validates the raw `initData` string a Telegram Mini App sends on launch.
// This is Telegram's official verification algorithm:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
// Returns the verified Telegram user object on success, or null if the
// data is missing, tampered with, or too old. Nothing here ever trusts
// a telegramId sent plainly by the client - only what this function
// verifies is used.
function validateInitData(initData, botToken, maxAgeSeconds) {
  if (!initData || !botToken) return null;
  maxAgeSeconds = maxAgeSeconds || 86400; // reject init data older than 24h by default

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch (e) {
    return null;
  }

  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const pairs = [];
  for (const [key, value] of params.entries()) {
    pairs.push(key + "=" + value);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  // Constant-time comparison to avoid timing attacks.
  const a = Buffer.from(computedHash, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = parseInt(params.get("auth_date") || "0", 10);
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (!authDate || ageSeconds > maxAgeSeconds || ageSeconds < -60) return null;

  let user;
  try {
    user = JSON.parse(params.get("user"));
  } catch (e) {
    return null;
  }
  if (!user || !user.id) return null;

  return user;
}

module.exports = { validateInitData };
