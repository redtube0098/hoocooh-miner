const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { findOrCreateUser } = require("../lib/userHelper");

const MAX_ADS_PER_DAY = 10;
const AD_REWARD = 15;
const MAX_SPIN_ADS_PER_DAY = 6;
const CYCLE_MS = 24 * 60 * 60 * 1000;

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

  try {
    const db = await getDb();
    const usersCol = db.collection("users");
    const tokensCol = db.collection("captcha_tokens");
    const uid = String(tgUser.id);

    let user = await findOrCreateUser(usersCol, tgUser);
    if (user && user.isBanned) {
      res.status(403).json({ error: "Your account has been suspended" });
      return;
    }

    const now = Date.now();

    // 1. GET: Fetch Ads and Spin status
    if (req.method === "GET") {
      let cycleStart = user.adsCycleStartedAt ? Number(user.adsCycleStartedAt) : 0;
      let watchedToday = Number(user.adsWatchedToday || 0);
      let earnedToday = Number(user.adsEarnedToday || 0);
      if (!cycleStart || (now - cycleStart >= CYCLE_MS)) {
        watchedToday = 0;
        earnedToday = 0;
        cycleStart = now;
      }

      let spinCycleStart = user.spinAdsCycleStartedAt ? Number(user.spinAdsCycleStartedAt) : 0;
      let spinWatchedToday = Number(user.spinAdsWatchedToday || 0);
      if (!spinCycleStart || (now - spinCycleStart >= CYCLE_MS)) {
        spinWatchedToday = 0;
        spinCycleStart = now;
      }

      // Verified referrals: friends with totalAdsWatched >= 30
      const verifiedRecruitsCount = await usersCol.countDocuments({
        referredBy: uid,
        totalAdsWatched: { $gte: 30 }
      });
      const claimedRefTickets = Number(user.claimedRefTickets || 0);
      const claimableRefTickets = Math.max(0, verifiedRecruitsCount - claimedRefTickets);

      res.status(200).json({
        ok: true,
        ads: {
          watchedToday,
          remainingToday: Math.max(0, MAX_ADS_PER_DAY - watchedToday),
          earnedToday,
          maxAds: MAX_ADS_PER_DAY,
          nextResetMs: Math.max(0, CYCLE_MS - (now - cycleStart))
        },
        spin: {
          tickets: Number(user.spinTickets || 0),
          watchedToday: spinWatchedToday,
          remainingToday: Math.max(0, MAX_SPIN_ADS_PER_DAY - spinWatchedToday),
          maxAds: MAX_SPIN_ADS_PER_DAY,
          nextResetMs: Math.max(0, CYCLE_MS - (now - spinCycleStart)),
          verifiedRecruitsCount,
          claimedRefTickets,
          claimableRefTickets
        }
      });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const { action } = req.body || {};

    // 2. ACTION: SPIN THE LUCKY WHEEL (Cost: 1 ticket)
    if (action === "spin") {
      const tickets = Number(user.spinTickets || 0);
      if (tickets < 1) {
        res.status(400).json({
          error: "You have 0 tickets! Watch ads or invite friends to get tickets.",
          tickets: 0
        });
        return;
      }

      // Probability distribution requested by user:
      // - 10 coins: 80% chance
      // - 15 coins: 15% chance
      // - remaining rewards (20, 25, 30): 5% chance
      const r = Math.random();
      let reward = 10;
      let segmentIndex = 0;

      // Wheel Sectors (8 total):
      // 0: 10, 1: 15, 2: 20, 3: 10, 4: 25, 5: 10, 6: 15, 7: 30
      if (r < 0.80) {
        reward = 10;
        const s10 = [0, 3, 5];
        segmentIndex = s10[Math.floor(Math.random() * s10.length)];
      } else if (r < 0.95) {
        reward = 15;
        const s15 = [1, 6];
        segmentIndex = s15[Math.floor(Math.random() * s15.length)];
      } else {
        const sub = (r - 0.95) / 0.05;
        if (sub < 0.50) {
          reward = 20;
          segmentIndex = 2;
        } else if (sub < 0.80) {
          reward = 25;
          segmentIndex = 4;
        } else {
          reward = 30;
          segmentIndex = 7;
        }
      }

      const newBalance = Number(user.balance || 0) + reward;
      const newTickets = tickets - 1;

      await usersCol.updateOne(
        { _id: user._id },
        {
          $set: {
            balance: newBalance,
            spinTickets: newTickets
          }
        }
      );

      res.status(200).json({
        ok: true,
        reward,
        segmentIndex,
        spinTickets: newTickets,
        newBalance
      });
      return;
    }

    // 3. ACTION: CLAIM REFERRAL TICKETS
    if (action === "claim_ref_tickets") {
      const verifiedRecruitsCount = await usersCol.countDocuments({
        referredBy: uid,
        totalAdsWatched: { $gte: 30 }
      });
      const alreadyClaimed = Number(user.claimedRefTickets || 0);
      const claimable = Math.max(0, verifiedRecruitsCount - alreadyClaimed);

      if (claimable <= 0) {
        res.status(400).json({ error: "No claimable tickets. Your friends must complete 30 ad watches to become verified." });
        return;
      }

      const newTickets = Number(user.spinTickets || 0) + claimable;
      const newClaimed = alreadyClaimed + claimable;

      await usersCol.updateOne(
        { _id: user._id },
        {
          $set: {
            spinTickets: newTickets,
            claimedRefTickets: newClaimed
          }
        }
      );

      res.status(200).json({
        ok: true,
        addedTickets: claimable,
        spinTickets: newTickets,
        claimedRefTickets: newClaimed,
        message: `🎉 Claimed +${claimable} free spin tickets!`
      });
      return;
    }

    // 4. AD WATCH VERIFICATION (Both for Spin Ticket Ad & Regular Ad)
    const { captchaToken } = req.body || {};
    if (!captchaToken) {
      res.status(403).json({ error: "Security verification required. Please solve the puzzle." });
      return;
    }

    const tokenDoc = await tokensCol.findOne({
      token: captchaToken,
      userId: { $in: [uid, Number(uid), tgUser.id] },
      used: false
    });

    if (!tokenDoc) {
      res.status(403).json({ error: "Invalid or expired verification. Please solve the puzzle again." });
      return;
    }

    if (now - Number(tokenDoc.createdAt || 0) > 90 * 1000) {
      res.status(403).json({ error: "Verification expired. Please try again." });
      return;
    }

    // Burn token
    await tokensCol.updateOne(
      { _id: tokenDoc._id },
      { $set: { used: true, usedAt: now } }
    );

    // 4A. ACTION: WATCH AD FOR SPIN TICKET (Up to 6 per 24 hours)
    if (action === "spin_watch_ad") {
      let spinCycleStart = user.spinAdsCycleStartedAt ? Number(user.spinAdsCycleStartedAt) : 0;
      let spinWatchedToday = Number(user.spinAdsWatchedToday || 0);

      if (!spinCycleStart || (now - spinCycleStart >= CYCLE_MS)) {
        spinWatchedToday = 0;
        spinCycleStart = now;
      }

      if (spinWatchedToday >= MAX_SPIN_ADS_PER_DAY) {
        const remainingMs = Math.max(0, CYCLE_MS - (now - spinCycleStart));
        res.status(400).json({
          error: "Daily limit of 6 tickets reached! Next tickets available in 24 hours.",
          remainingMs,
          spinWatchedToday,
          maxAds: MAX_SPIN_ADS_PER_DAY
        });
        return;
      }

      spinWatchedToday += 1;
      const newTickets = Number(user.spinTickets || 0) + 1;
      const totalAds = Number(user.totalAdsWatched || 0) + 1;

      await usersCol.updateOne(
        { _id: user._id },
        {
          $set: {
            spinTickets: newTickets,
            spinAdsWatchedToday: spinWatchedToday,
            spinAdsCycleStartedAt: spinCycleStart,
            totalAdsWatched: totalAds
          }
        }
      );

      res.status(200).json({
        ok: true,
        ticketAdded: 1,
        spinTickets: newTickets,
        spinAdsWatchedToday: spinWatchedToday,
        remainingToday: MAX_SPIN_ADS_PER_DAY - spinWatchedToday,
        maxAds: MAX_SPIN_ADS_PER_DAY,
        message: "🎟️ +1 Spin Ticket added!"
      });
      return;
    }

    // 4B. ACTION: REGULAR WATCH & EARN (+15 Coins)
    let cycleStart = user.adsCycleStartedAt ? Number(user.adsCycleStartedAt) : 0;
    let watchedToday = Number(user.adsWatchedToday || 0);
    let earnedToday = Number(user.adsEarnedToday || 0);

    if (!cycleStart || (now - cycleStart >= CYCLE_MS)) {
      watchedToday = 0;
      earnedToday = 0;
      cycleStart = now;
    }

    if (watchedToday >= MAX_ADS_PER_DAY) {
      const remainingMs = Math.max(0, CYCLE_MS - (now - cycleStart));
      res.status(400).json({
        error: "Daily limit of 10 ads reached! Next ads available in 24 hours.",
        remainingMs,
        adsWatchedToday: watchedToday,
        adsEarnedToday: earnedToday,
        adsCycleStartedAt: cycleStart
      });
      return;
    }

    watchedToday += 1;
    earnedToday += AD_REWARD;
    const newBalance = Number(user.balance || 0) + AD_REWARD;
    const totalAds = Number(user.totalAdsWatched || 0) + 1;

    await usersCol.updateOne(
      { _id: user._id },
      {
        $set: {
          balance: newBalance,
          adsWatchedToday: watchedToday,
          adsEarnedToday: earnedToday,
          adsCycleStartedAt: cycleStart,
          totalAdsWatched: totalAds
        }
      }
    );

    res.status(200).json({
      ok: true,
      reward: AD_REWARD,
      newBalance,
      adsWatchedToday: watchedToday,
      adsEarnedToday: earnedToday,
      adsCycleStartedAt: cycleStart,
      remainingToday: MAX_ADS_PER_DAY - watchedToday,
      maxAds: MAX_ADS_PER_DAY
    });
  } catch (err) {
    console.error("ads.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
