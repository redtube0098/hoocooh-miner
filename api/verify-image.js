const { generateVerificationImage } = require("../lib/verificationImage");

module.exports = async (req, res) => {
  // Extract 4-digit code from query parameter
  const rawCode = String(req.query.code || req.query.c || "").replace(/\D/g, "");
  const code = rawCode.slice(0, 4);

  if (!code || code.length !== 4) {
    res.setHeader("Content-Type", "text/plain");
    res.status(400).send("Invalid or missing 4-digit code");
    return;
  }

  try {
    const pngBuffer = generateVerificationImage(code);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("Content-Length", pngBuffer.length);
    res.status(200).end(pngBuffer);
  } catch (err) {
    console.error("verify-image generation error:", err);
    res.setHeader("Content-Type", "text/plain");
    res.status(500).send("Failed to generate verification image");
  }
};
