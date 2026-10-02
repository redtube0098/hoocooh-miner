const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");

const MILESTONES_CONFIG = [
  { id: 1, required: 5, reward: 100, title: "Invite 5 Friends" },
  { id: 2, required: 10, reward: 200, title: "Invite 10 Friends" },
  { id: 3, required: 25, reward: 500, title: "Invite 25 Friends" },
  { id: 4, required: 50, reward: 1500, title: "Invite 50 Friends" }
];

// Realistic leaderboard seeds from reference screenshots
const DEMO_RECRUITERS = [
  { rank: 1, name: "Rahman islam (p...", username: "@Rahmanislamq", recruitsCount: 2242, avatarText: "MR" },
  { rank: 2, name: "Casey Web3", username: "@CaseyWeb3", recruitsCount: 1404, avatarText: "CW" },
  { rank: 3, name: "ST TUHIN", username: "@Tuhinprimiamapps", recruitsCount: 752, avatarText: "ST" },
  { rank: 4, name: "Dipak Tajpuriya", username: "@dipaktajpuriya", recruitsCount: 681, avatarText: "DT" },
  { rank: 5, name: "Nova |", username: "@AI_9001", recruitsCount: 587, avatarText: "NV" },
  { rank: 6, name: "sh khishvand", username: "@Shoeibkh1982", recruitsCount: 554, avatarText: "SK" },
  { rank: 7, name: "Patience", username: "@Perkybest", recruitsCount: 508, avatarText: "PT" },
  { rank: 8, name: "Alexander K.", username: "@alex_k_crypto", recruitsCount: 462, avatarText: "AK" },
  { rank: 9, name: "Crypto Vanguard", username: "@vanguard_node", recruitsCount: 419, avatarText: "CV" },
  { rank: 10, name: "Satoshi Realm", username: "@satoshi_ton", recruitsCount: 388, avatarText: "SR" },
  { rank: 11, name: "Elena Rostova", username: "@elena_ton_miner", recruitsCount: 341, avatarText: "ER" },
  { rank: 12, name: "Farhan Ahmed", username: "@farhan_web3", recruitsCount: 310, avatarText: "FA" },
  { rank: 13, name: "TON Bull 2026", username: "@ton_bull_run", recruitsCount: 289, avatarText: "TB" },
  { rank: 14, name: "Moon Harvest", username: "@moon_harvest_io", recruitsCount: 254, avatarText: "MH" },
  { rank: 15, name: "Aria Stark", username: "@aria_gem", recruitsCount: 230, avatarText: "AS" },
  { rank: 16, name: "Block Nomad", username: "@block_nomad", recruitsCount: 215, avatarText: "BN" },
  { rank: 17, name: "David Kim", username: "@davidkim_crypto", recruitsCount: 198, avatarText: "DK" },
  { rank: 18, name: "Alpha Hunters", username: "@alpha_hunters_club", recruitsCount: 182, avatarText: "AH" },
  { rank: 19, name: "Zubair Khan", username: "@zubair_mine", recruitsCount: 165, avatarText: "ZK" },
  { rank: 20, name: "Apex Syndicate", username: "@apex_syndicate", recruitsCount: 152, avatarText: "AS" }
];

const DEMO_MINERS = [
  { rank: 1, name: "Quantum Rig 01", username: "@quantum_hash", score: 842500, minerLevel: 10, avatarText: "QR" },
  { rank: 2, name: "Sovereign Apex", username: "@sovereign_core", score: 671200, minerLevel: 9, avatarText: "SA" },
  { rank: 3, name: "Titan Harvester", username: "@titan_mine_ton", score: 539000, minerLevel: 8, avatarText: "TH" },
  { rank: 4, name: "Cosmic Pulse", username: "@cosmic_pulse", score: 482100, minerLevel: 8, avatarText: "CP" },
  { rank: 5, name: "Nexus Prime", username: "@nexus_prime", score: 419800, minerLevel: 7, avatarText: "NP" },
  { rank: 6, name: "Aether Void", username: "@aether_void", score: 388400, minerLevel: 7, avatarText: "AV" },
  { rank: 7, name: "Vortex Node", username: "@vortex_node", score: 351200, minerLevel: 6, avatarText: "VN" },
  { rank: 8, name: "Hyperion Core", username: "@hyperion_core", score: 326700, minerLevel: 6, avatarText: "HC" },
  { rank: 9, name: "Blaze Runner", username: "@blaze_run", score: 295400, minerLevel: 6, avatarText: "BR" },
  { rank: 10, name: "Starlight Rig", username: "@starlight_rig", score: 271000, minerLevel: 5, avatarText: "SR" }
];

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
    const user = await usersCol.findOne({ telegramId });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const userRecruits = Number(user.recruitsCount || 0);
    const userRefEarnings = Number(user.refEarnings || 0);
    const userClaimedMilestones = Array.isArray(user.claimedMilestones) ? user.claimedMilestones : [];

    // 1. GET: Fetch rankings & milestones
    if (req.method === "GET") {
      // Find top recruiters in DB
      const dbRecruiters = await usersCol
        .find({ recruitsCount: { $gt: 0 } })
        .sort({ recruitsCount: -1, balance: -1 })
        .limit(20)
        .toArray();

      let topRecruiters = [];
      let seenIds = new Set();

      dbRecruiters.forEach((u, idx) => {
        seenIds.add(u.telegramId);
        const displayName = u.firstName ? (u.firstName + (u.lastName ? " " + u.lastName : "")) : (u.username || "Miner");
        topRecruiters.push({
          rank: idx + 1,
          telegramId: u.telegramId,
          name: displayName,
          username: u.username ? ("@" + u.username) : "",
          recruitsCount: u.recruitsCount || 0,
          avatarText: displayName.slice(0, 2).toUpperCase()
        });
      });

      // Fill remaining spots from demo seeds if needed
      for (const demo of DEMO_RECRUITERS) {
        if (topRecruiters.length >= 20) break;
        topRecruiters.push({
          ...demo,
          rank: topRecruiters.length + 1
        });
      }

      // Check user recruiter rank
      let recruiterRank = null;
      if (userRecruits > 0) {
        const higherCount = await usersCol.countDocuments({ recruitsCount: { $gt: userRecruits } });
        const exactRank = higherCount + 1;
        if (exactRank <= 99) {
          recruiterRank = exactRank;
        }
      }

      // Find top miners in DB
      const dbMiners = await usersCol
        .find({})
        .sort({ balance: -1 })
        .limit(100)
        .toArray();

      let topMiners = [];
      dbMiners.forEach((u, idx) => {
        const displayName = u.firstName ? (u.firstName + (u.lastName ? " " + u.lastName : "")) : (u.username || "Miner");
        topMiners.push({
          rank: idx + 1,
          telegramId: u.telegramId,
          name: displayName,
          username: u.username ? ("@" + u.username) : "",
          score: Math.round(Number(u.balance || 0)),
          minerLevel: u.minerLevel || 1,
          avatarText: displayName.slice(0, 2).toUpperCase()
        });
      });

      for (const demo of DEMO_MINERS) {
        if (topMiners.length >= 100) break;
        topMiners.push({
          ...demo,
          rank: topMiners.length + 1
        });
      }

      // Check user miner rank
      const userBal = Number(user.balance || 0);
      const higherBalCount = await usersCol.countDocuments({ balance: { $gt: userBal } });
      const minerExactRank = higherBalCount + 1;
      let minerRank = null;
      if (minerExactRank <= 100) {
        minerRank = minerExactRank;
      }

      // Milestones mapping
      const milestones = MILESTONES_CONFIG.map(m => {
        const isClaimed = userClaimedMilestones.includes(m.id);
        const canClaim = !isClaimed && (userRecruits >= m.required);
        return {
          id: m.id,
          required: m.required,
          reward: m.reward,
          title: m.title,
          isClaimed: isClaimed,
          canClaim: canClaim
        };
      });

      const claimedCount = milestones.filter(m => m.isClaimed).length;

      res.status(200).json({
        ok: true,
        recruitsCount: userRecruits,
        refEarnings: userRefEarnings,
        recruiterRank: recruiterRank,
        minerRank: minerRank,
        topRecruiters: topRecruiters.slice(0, 20),
        topMiners: topMiners.slice(0, 100),
        milestones: milestones,
        claimedMilestonesCount: claimedCount,
        totalMilestones: MILESTONES_CONFIG.length
      });
      return;
    }

    // 2. POST: Claim milestone
    if (req.method === "POST") {
      const { action, milestoneId } = req.body || {};

      if (action === "claim_milestone") {
        const mConfig = MILESTONES_CONFIG.find(m => m.id === Number(milestoneId));
        if (!mConfig) {
          res.status(400).json({ error: "Invalid milestone" });
          return;
        }

        if (userClaimedMilestones.includes(mConfig.id)) {
          res.status(400).json({ error: "Milestone already claimed" });
          return;
        }

        if (userRecruits < mConfig.required) {
          res.status(400).json({
            error: `You need ${mConfig.required} recruits to claim this milestone. Current: ${userRecruits}`
          });
          return;
        }

        const newBal = (Number(user.balance) || 0) + mConfig.reward;
        const newClaimed = [...userClaimedMilestones, mConfig.id];

        await usersCol.updateOne(
          { telegramId },
          {
            $set: { balance: newBal, claimedMilestones: newClaimed }
          }
        );

        res.status(200).json({
          ok: true,
          reward: mConfig.reward,
          newBalance: newBal,
          claimedMilestones: newClaimed,
          message: `🎉 +${mConfig.reward} HOOCOOH Coins milestone reward claimed!`
        });
        return;
      }

      res.status(400).json({ error: "Unknown action" });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("referral.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
