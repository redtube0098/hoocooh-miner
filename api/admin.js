const { getDb } = require("../lib/mongodb");
const { ObjectId } = require("mongodb");

const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || "hoocooh_admin_2026";

function checkAdminAuth(req) {
  const headerKey = req.headers["x-admin-key"];
  const bodyKey = req.body && req.body.adminKey;
  const queryKey = req.query && req.query.adminKey;
  const key = headerKey || bodyKey || queryKey;
  return key && String(key).trim() === String(ADMIN_SECRET).trim();
}

async function sendTelegramMsg(botToken, chatId, text, options = {}) {
  if (!botToken || !chatId) return false;
  try {
    const payload = {
      chat_id: String(chatId),
      parse_mode: "HTML",
      disable_web_page_preview: false
    };

    let url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    if (options.photoUrl) {
      url = `https://api.telegram.org/bot${botToken}/sendPhoto`;
      payload.photo = options.photoUrl;
      payload.caption = text;
    } else {
      payload.text = text;
    }

    if (options.buttonText && options.buttonUrl) {
      payload.reply_markup = {
        inline_keyboard: [
          [{ text: options.buttonText, url: options.buttonUrl }]
        ]
      };
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    return data.ok;
  } catch (e) {
    return false;
  }
}

module.exports = async (req, res) => {
  // CORS / Options preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-admin-key");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (!checkAdminAuth(req)) {
    res.status(401).json({ error: "Unauthorized: Invalid Admin Secret Key" });
    return;
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  try {
    const db = await getDb();
    const usersCol = db.collection("users");
    const withdrawalsCol = db.collection("withdrawals");
    const tasksCol = db.collection("tasks");

    // ==========================================
    // GET Requests: Stats, Withdrawals, Users, Tasks
    // ==========================================
    if (req.method === "GET") {
      const action = req.query.action || "stats";

      // 1. Stats
      if (action === "stats") {
        const totalUsers = await usersCol.countDocuments({});
        const bannedUsers = await usersCol.countDocuments({ isBanned: true });
        const pendingW = await withdrawalsCol.countDocuments({ status: "PENDING" });
        const approvedW = await withdrawalsCol.countDocuments({ status: "APPROVED" });

        const balAgg = await usersCol.aggregate([
          { $group: { _id: null, totalCoins: { $sum: "$balance" } } }
        ]).toArray();
        const totalCoins = balAgg[0] ? balAgg[0].totalCoins : 0;

        const paidAgg = await withdrawalsCol.aggregate([
          { $match: { status: "APPROVED" } },
          { $group: { _id: null, totalUsdt: { $sum: "$usdtAmount" } } }
        ]).toArray();
        const totalPaidUsdt = paidAgg[0] ? paidAgg[0].totalUsdt : 0;

        res.status(200).json({
          ok: true,
          totalUsers,
          bannedUsers,
          pendingWithdrawals: pendingW,
          approvedWithdrawals: approvedW,
          totalCoinsInCirculation: Math.round(totalCoins),
          totalPaidUsdt: Number(totalPaidUsdt.toFixed(2))
        });
        return;
      }

      // 2. Withdrawals List
      if (action === "withdrawals") {
        const filter = {};
        if (req.query.status && req.query.status !== "ALL") {
          filter.status = req.query.status.toUpperCase();
        }

        const rawList = await withdrawalsCol
          .find(filter)
          .sort({ createdAt: -1 })
          .limit(100)
          .toArray();

        // Attach user info
        const userIds = [...new Set(rawList.map(w => String(w.telegramId)))];
        const usersMap = {};
        if (userIds.length > 0) {
          const foundUsers = await usersCol.find({
            $or: [
              { telegramId: { $in: userIds } },
              { telegramId: { $in: userIds.map(Number).filter(Boolean) } }
            ]
          }).toArray();
          foundUsers.forEach(u => {
            usersMap[String(u.telegramId)] = u;
          });
        }

        const list = rawList.map(w => {
          const u = usersMap[String(w.telegramId)] || {};
          return {
            id: String(w._id),
            telegramId: w.telegramId,
            username: u.username ? ("@" + u.username) : "N/A",
            name: (u.firstName || "") + (u.lastName ? " " + u.lastName : "") || "Miner",
            currentBalance: Number(u.balance || 0),
            recruitsCount: Number(u.recruitsCount || 0),
            isBanned: !!u.isBanned,
            amount: w.amount,
            usdtAmount: w.usdtAmount,
            walletAddress: w.walletAddress,
            network: w.network || "USDT (TON)",
            status: w.status || "PENDING",
            txHash: w.txHash || "",
            createdAt: w.createdAt,
            approvedAt: w.approvedAt,
            rejectedAt: w.rejectedAt,
            reason: w.reason || ""
          };
        });

        res.status(200).json({ ok: true, withdrawals: list });
        return;
      }

      // 3. Search User (UID or Username)
      if (action === "search_user") {
        const q = String(req.query.q || "").trim();
        if (!q) {
          res.status(400).json({ error: "Search query required" });
          return;
        }

        const cleanUsername = q.replace(/^@/, "");
        const numId = Number(q);

        const query = {
          $or: [
            { telegramId: q },
            ...(numId ? [{ telegramId: numId }] : []),
            { username: { $regex: cleanUsername, $options: "i" } },
            { firstName: { $regex: q, $options: "i" } }
          ]
        };

        const found = await usersCol.find(query).limit(20).toArray();
        const mapped = found.map(u => ({
          id: String(u._id),
          telegramId: String(u.telegramId),
          name: (u.firstName || "") + (u.lastName ? " " + u.lastName : "") || "Miner",
          username: u.username ? ("@" + u.username) : "N/A",
          photoUrl: u.photoUrl || "",
          balance: Number(u.balance || 0),
          minerLevel: u.minerLevel || 1,
          recruitsCount: Number(u.recruitsCount || 0),
          refEarnings: Number(u.refEarnings || 0),
          isBanned: !!u.isBanned,
          banReason: u.banReason || "",
          createdAt: u.createdAt || null
        }));

        res.status(200).json({ ok: true, users: mapped });
        return;
      }

      // 4. Tasks List
      if (action === "tasks") {
        const customTasks = await tasksCol.find({}).sort({ createdAt: -1 }).toArray();
        const mapped = customTasks.map(t => ({
          id: String(t._id),
          title: t.title,
          link: t.link,
          type: t.type || "normal",
          reward: 10,
          targetCount: t.targetCount === 99999999 || !t.targetCount ? "Unlimited" : t.targetCount,
          completedCount: (t.completedBy || []).length,
          status: t.status || "active",
          creatorId: t.creatorId,
          createdAt: t.createdAt
        }));

        res.status(200).json({ ok: true, tasks: mapped });
        return;
      }

      res.status(400).json({ error: "Unknown GET action" });
      return;
    }

    // ==========================================
    // POST Requests: Actions (Approve, Reject, Ban, Unban, Funds, Broadcast, Tasks)
    // ==========================================
    if (req.method === "POST") {
      const { action } = req.body || {};

      // 1. Approve Withdrawal
      if (action === "approve_withdrawal") {
        const { withdrawalId, txHash } = req.body || {};
        if (!withdrawalId) {
          res.status(400).json({ error: "withdrawalId required" });
          return;
        }

        let objId;
        try { objId = new ObjectId(withdrawalId); } catch(e){ objId = null; }
        const wQuery = objId ? { _id: objId } : { _id: withdrawalId };

        const w = await withdrawalsCol.findOne(wQuery);
        if (!w) {
          res.status(404).json({ error: "Withdrawal not found" });
          return;
        }

        const now = Date.now();
        const finalTx = txHash ? txHash.trim() : ("0x" + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2));

        await withdrawalsCol.updateOne(wQuery, {
          $set: {
            status: "APPROVED",
            txHash: finalTx,
            approvedAt: now
          }
        });

        // Notify user via Telegram Bot
        if (botToken && w.telegramId) {
          const msg = `🎉 <b>Withdrawal Approved!</b>\n\nYour payout of <b>${w.amount.toLocaleString()} HOOCOOH Coins ($${w.usdtAmount} USDT)</b> has been confirmed.\n\n<b>Destination:</b> <code>${w.walletAddress}</code>\n<b>TxHash:</b> <code>${finalTx}</code>\n\nThank you for mining with HOOCOOH!`;
          sendTelegramMsg(botToken, w.telegramId, msg);
        }

        res.status(200).json({ ok: true, message: "Withdrawal approved successfully!", txHash: finalTx });
        return;
      }

      // 2. Reject Withdrawal (Refunds coins back to user balance!)
      if (action === "reject_withdrawal") {
        const { withdrawalId, reason } = req.body || {};
        if (!withdrawalId) {
          res.status(400).json({ error: "withdrawalId required" });
          return;
        }

        let objId;
        try { objId = new ObjectId(withdrawalId); } catch(e){ objId = null; }
        const wQuery = objId ? { _id: objId } : { _id: withdrawalId };

        const w = await withdrawalsCol.findOne(wQuery);
        if (!w) {
          res.status(404).json({ error: "Withdrawal not found" });
          return;
        }

        const now = Date.now();
        const refundAmt = Number(w.amount || 0);
        const rejReason = (reason || "Review failed / suspicious activity").trim();

        // Update withdrawal
        await withdrawalsCol.updateOne(wQuery, {
          $set: {
            status: "REJECTED",
            reason: rejReason,
            rejectedAt: now
          }
        });

        // Refund coins to user
        const tid = String(w.telegramId);
        const numId = Number(w.telegramId);
        await usersCol.updateOne(
          { $or: [{ telegramId: tid }, ...(numId ? [{ telegramId: numId }] : [])] },
          { $inc: { balance: refundAmt } }
        );

        // Notify user via Telegram Bot
        if (botToken && w.telegramId) {
          const msg = `⚠️ <b>Withdrawal Rejected & Refunded</b>\n\nYour request for <b>${refundAmt.toLocaleString()} Coins</b> was rejected.\n<b>Reason:</b> ${rejReason}\n\nYour <b>${refundAmt.toLocaleString()} HOOCOOH Coins</b> have been returned to your miner balance.`;
          sendTelegramMsg(botToken, w.telegramId, msg);
        }

        res.status(200).json({ ok: true, message: `Withdrawal rejected and ${refundAmt.toLocaleString()} coins refunded to user.` });
        return;
      }

      // 3. Ban User (and optionally reject pending withdrawal)
      if (action === "ban_user") {
        const { telegramId, reason, withdrawalId } = req.body || {};
        if (!telegramId) {
          res.status(400).json({ error: "telegramId required" });
          return;
        }

        const tid = String(telegramId);
        const numId = Number(telegramId);
        const banReason = (reason || "Violation of HOOCOOH Miner rules & anti-cheat policies").trim();

        await usersCol.updateMany(
          { $or: [{ telegramId: tid }, ...(numId ? [{ telegramId: numId }] : [])] },
          { $set: { isBanned: true, banReason: banReason, bannedAt: Date.now() } }
        );

        // If from withdrawal, reject it
        if (withdrawalId) {
          let objId;
          try { objId = new ObjectId(withdrawalId); } catch(e){ objId = null; }
          await withdrawalsCol.updateOne(
            objId ? { _id: objId } : { _id: withdrawalId },
            { $set: { status: "REJECTED", reason: "User Banned: " + banReason, rejectedAt: Date.now() } }
          );
        }

        // Notify banned user
        if (botToken) {
          const msg = `⛔ <b>Account Suspended</b>\n\nYour HOOCOOH Miner account has been suspended.\n<b>Reason:</b> ${banReason}\n\nYou can no longer access the miner application.`;
          sendTelegramMsg(botToken, tid, msg);
        }

        res.status(200).json({ ok: true, message: `User ${tid} has been permanently banned.` });
        return;
      }

      // 4. Unban User
      if (action === "unban_user") {
        const { telegramId } = req.body || {};
        if (!telegramId) {
          res.status(400).json({ error: "telegramId required" });
          return;
        }

        const tid = String(telegramId);
        const numId = Number(telegramId);

        await usersCol.updateMany(
          { $or: [{ telegramId: tid }, ...(numId ? [{ telegramId: numId }] : [])] },
          { $set: { isBanned: false, banReason: null, unbannedAt: Date.now() } }
        );

        // Notify user
        if (botToken) {
          const msg = `✅ <b>Account Restored!</b>\n\nYour suspension has been lifted. You can now reopen and continue mining on HOOCOOH Miner.`;
          sendTelegramMsg(botToken, tid, msg);
        }

        res.status(200).json({ ok: true, message: `User ${tid} has been unbanned successfully.` });
        return;
      }

      // 5. Update Funds (Add or Deduct coins)
      if (action === "update_funds") {
        const { telegramId, delta, note } = req.body || {};
        if (!telegramId || delta === undefined) {
          res.status(400).json({ error: "telegramId and delta required" });
          return;
        }

        const numDelta = parseInt(delta, 10);
        if (isNaN(numDelta) || numDelta === 0) {
          res.status(400).json({ error: "Delta must be a non-zero integer" });
          return;
        }

        const tid = String(telegramId);
        const numId = Number(telegramId);

        const targetUser = await usersCol.findOne({
          $or: [{ telegramId: tid }, ...(numId ? [{ telegramId: numId }] : [])]
        });

        if (!targetUser) {
          res.status(404).json({ error: "User not found" });
          return;
        }

        const currentBal = Number(targetUser.balance || 0);
        const newBal = Math.max(0, currentBal + numDelta);

        await usersCol.updateOne(
          { _id: targetUser._id },
          { $set: { balance: newBal } }
        );

        // Notify user if added/deducted
        if (botToken) {
          const sign = numDelta > 0 ? "+" : "";
          const msg = `💰 <b>Balance Adjustment by Admin</b>\n\nYour balance was adjusted by: <b>${sign}${numDelta.toLocaleString()} HOOCOOH Coins</b>\n<b>New Balance:</b> ${newBal.toLocaleString()} Coins\n${note ? ("<b>Note:</b> " + note) : ""}`;
          sendTelegramMsg(botToken, tid, msg);
        }

        res.status(200).json({
          ok: true,
          previousBalance: currentBal,
          newBalance: newBal,
          delta: numDelta,
          message: `Balance updated: ${currentBal.toLocaleString()} -> ${newBal.toLocaleString()} Coins.`
        });
        return;
      }

      // 6. Broadcast to All Users
      if (action === "broadcast") {
        const { message, photoUrl, buttonText, buttonUrl } = req.body || {};
        if (!message || !message.trim()) {
          res.status(400).json({ error: "Message is required" });
          return;
        }

        if (!botToken) {
          res.status(500).json({ error: "TELEGRAM_BOT_TOKEN is not set" });
          return;
        }

        const allUsers = await usersCol.find({}, { projection: { telegramId: 1 } }).toArray();
        const total = allUsers.length;

        // Perform async broadcast in batches
        let sentCount = 0;
        let failCount = 0;

        for (const u of allUsers) {
          const tid = u.telegramId;
          if (!tid) continue;
          const ok = await sendTelegramMsg(botToken, tid, message.trim(), {
            photoUrl: (photoUrl || "").trim() || null,
            buttonText: (buttonText || "").trim() || null,
            buttonUrl: (buttonUrl || "").trim() || null
          });
          if (ok) sentCount++;
          else failCount++;

          // Respect Telegram 30 msgs/sec limits: 35ms pause
          await new Promise(r => setTimeout(r, 35));
        }

        res.status(200).json({
          ok: true,
          message: `Broadcast finished: ${sentCount} sent, ${failCount} failed.`,
          sentCount,
          failCount,
          totalUsers: total
        });
        return;
      }

      // 7. Create Task (Admin can post for free, set limit or unlimited, reward fixed at 10)
      if (action === "create_task") {
        const { title, link, type, targetUsers, isUnlimited } = req.body || {};
        if (!title || !title.trim()) {
          res.status(400).json({ error: "Task title is required" });
          return;
        }
        if (!link || !link.trim()) {
          res.status(400).json({ error: "Link is required" });
          return;
        }

        let cleanLink = link.trim();
        if (!cleanLink.startsWith("http") && !cleanLink.startsWith("t.me")) {
          cleanLink = "https://t.me/" + cleanLink.replace(/^@/, "");
        } else if (cleanLink.startsWith("t.me")) {
          cleanLink = "https://" + cleanLink;
        }

        const taskType = type === "verified" ? "verified" : "normal";
        const finalCount = isUnlimited ? 99999999 : (Math.max(1, parseInt(targetUsers, 10) || 100));

        const newTask = {
          creatorId: "admin",
          type: taskType,
          title: title.trim(),
          link: cleanLink,
          reward: 10, // Strictly fixed at 10 HOOCOOH Coins as required!
          targetCount: finalCount,
          isUnlimited: !!isUnlimited,
          completedBy: [],
          status: "active",
          createdAt: Date.now()
        };

        const insRes = await tasksCol.insertOne(newTask);

        res.status(200).json({
          ok: true,
          task: { id: String(insRes.insertedId), ...newTask },
          message: `Task successfully created! Target: ${isUnlimited ? 'Unlimited' : finalCount} users, Reward: 10 HOOCOOH Coins.`
        });
        return;
      }

      // 8. Delete / Disable Task
      if (action === "delete_task") {
        const { taskId } = req.body || {};
        if (!taskId) {
          res.status(400).json({ error: "taskId is required" });
          return;
        }

        let objId;
        try { objId = new ObjectId(taskId); } catch(e){ objId = null; }
        const tQuery = objId ? { _id: objId } : { _id: taskId };

        await tasksCol.deleteOne(tQuery);

        res.status(200).json({ ok: true, message: "Task deleted successfully." });
        return;
      }

      res.status(400).json({ error: "Unknown POST action" });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("admin.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
