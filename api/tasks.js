const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { findOrCreateUser } = require("../lib/userHelper");
const { getAdminDepositAddress, checkTonDeposit, notifyUserTaskActivated } = require("../lib/tonDeposit");
const { ObjectId } = require("mongodb");

module.exports = async (req, res) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    res.status(500).json({ error: "TELEGRAM_BOT_TOKEN is not configured" });
    return;
  }

  // 0. CRON JOB TRIGGER (compatible with cron-job.org & external services)
  // Check all pending task deposits on-chain without requiring user Telegram session
  const isCron = (req.query && (req.query.cron === "check_deposits" || req.query.cron === "deposit" || req.query.cron === "true")) ||
                 (req.headers && (req.headers["x-cron-check"] === "check_deposits" || (req.headers["user-agent"] && req.headers["user-agent"].includes("cron-job.org"))));
  if (isCron) {
    try {
      const db = await getDb();
      const tasksCol = db.collection("tasks");
      const pendingTasks = await tasksCol
        .find({ status: "pending_payment", createdAt: { $gt: Date.now() - 24 * 60 * 60 * 1000 } })
        .toArray();

      let activated = 0;
      for (const t of pendingTasks) {
        if (!t.depositAddress || !t.memo) continue;
        const resCheck = await checkTonDeposit(t.depositAddress, t.tonCost, t.memo);
        if (resCheck.verified) {
          await tasksCol.updateOne(
            { _id: t._id },
            { $set: { status: "active", paid: true, paidAt: Date.now(), txHash: resCheck.txHash } }
          );
          if (t.creatorId) {
            await notifyUserTaskActivated(botToken, t.creatorId, t, resCheck.txHash);
          }
          activated++;
        }
      }

      res.status(200).json({ ok: true, processed: pendingTasks.length, activated });
      return;
    } catch (cronErr) {
      console.error("Cron check_deposits error:", cronErr);
      res.status(500).json({ error: cronErr.message });
      return;
    }
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
    const tasksCol = db.collection("tasks");
    const usersCol = db.collection("users");

    // Retrieve or merge unified user record
    const user = await findOrCreateUser(usersCol, tgUser);

    if (user && user.isBanned) {
      res.status(403).json({ error: "Your account has been suspended" });
      return;
    }

    // GET: list tasks (Only show tasks that the user hasn't completed yet!)
    if (req.method === "GET") {
      const userCompleted = (user && user.completedTasks) || [];

      // Find active tasks from database
      const customTasks = await tasksCol.find({ status: "active" }).sort({ createdAt: -1 }).toArray();

      // Filter out tasks already completed/claimed by this user OR target limit reached
      const activeTasks = customTasks.filter(t => {
        const idStr = String(t._id);
        const completedArr = t.completedBy || [];
        const isCompleted = userCompleted.includes(idStr) || completedArr.includes(telegramId);
        
        // If user already claimed this task, it disappears!
        if (isCompleted) return false;

        // If target limit reached (and not unlimited), hide from new users
        if (!t.isUnlimited && t.targetCount && completedArr.length >= t.targetCount) {
          return false;
        }

        return true;
      });

      const mapped = activeTasks.map(t => {
        const idStr = String(t._id);
        const completedArr = t.completedBy || [];
        return {
          id: idStr,
          type: t.type || "normal",
          title: t.title,
          link: t.link,
          reward: 10,
          targetCount: t.targetCount === 99999999 || !t.targetCount || t.isUnlimited ? "Unlimited" : t.targetCount,
          completedCount: completedArr.length,
          isCompleted: false
        };
      });

      res.status(200).json({ ok: true, tasks: mapped });
      return;
    }

    // POST: claim or create
    if (req.method === "POST") {
      const { action } = req.body || {};

      // 1. CLAIM
      if (action === "claim") {
        const { taskId } = req.body || {};
        if (!taskId) {
          res.status(400).json({ error: "Task ID is required" });
          return;
        }

        const userCompleted = (user && user.completedTasks) || [];
        if (userCompleted.includes(String(taskId))) {
          res.status(400).json({ error: "Task already claimed" });
          return;
        }

        let objId;
        try { objId = new ObjectId(taskId); } catch(e) { objId = null; }
        const taskQuery = objId ? { _id: objId } : { _id: taskId };
        const taskObj = await tasksCol.findOne(taskQuery);

        if (!taskObj) {
          res.status(404).json({ error: "Task not found" });
          return;
        }

        // Verified task check: User must actually have joined the Telegram channel/group!
        if (taskObj.type === "verified" && taskObj.link) {
          let cleanChat = taskObj.link.trim()
            .replace(/https?:\/\/t\.me\//i, "")
            .replace(/^@/, "")
            .split("/")[0]
            .split("?")[0]
            .trim();

          if (cleanChat) {
            const targetChatId = "@" + cleanChat;
            try {
              const checkRes = await fetch(
                `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(targetChatId)}&user_id=${telegramId}`
              );
              const checkData = await checkRes.json();

              if (!checkData.ok) {
                const desc = (checkData.description || "").toLowerCase();
                // If user not in chat
                if (desc.includes("user not found") || desc.includes("user_not_participant")) {
                  res.status(400).json({
                    error: `You haven't joined ${targetChatId} yet! Please join first to claim reward.`
                  });
                  return;
                } else if (!desc.includes("chat not found")) {
                  res.status(400).json({
                    error: `Please join ${targetChatId} to claim your +10 HOOCOOH reward!`
                  });
                  return;
                }
              } else {
                const memberStatus = checkData.result && checkData.result.status;
                if (memberStatus === "left" || memberStatus === "kicked" || !memberStatus) {
                  res.status(400).json({
                    error: `You must join ${targetChatId} first to claim your +10 HOOCOOH reward!`
                  });
                  return;
                }
              }
            } catch (checkErr) {
              console.warn("Telegram membership check warning:", checkErr);
              res.status(400).json({
                error: `Could not verify membership for ${targetChatId}. Please make sure you joined and try again.`
              });
              return;
            }
          }
        }

        if (taskQuery) {
          await tasksCol.updateOne(taskQuery, { $addToSet: { completedBy: telegramId } });
        }

        const currentBal = Number(user.balance || 0);
        const newBal = currentBal + 10;

        await usersCol.updateOne(
          { _id: user._id },
          {
            $set: { balance: newBal },
            $addToSet: { completedTasks: String(taskId) }
          }
        );

        res.status(200).json({ ok: true, reward: 10, newBalance: newBal });
        return;
      }

      // 2. CREATE (Initializes task with pending_payment status and returns deposit details)
      if (action === "create") {
        const { title, link, type, targetUsers } = req.body || {};
        if (!title || !title.trim()) {
          res.status(400).json({ error: "Task title is required" });
          return;
        }
        if (!link || !link.trim()) {
          res.status(400).json({ error: "Channel/Group link or username is required" });
          return;
        }

        const count = Math.max(100, parseInt(targetUsers, 10) || 100);
        const taskType = type === "verified" ? "verified" : "normal";
        const tonCost = Number(req.body.tonCost || ((count / 100) * 0.15).toFixed(2));

        let cleanLink = link.trim();
        if (!cleanLink.startsWith("http") && !cleanLink.startsWith("t.me")) {
          cleanLink = "https://t.me/" + cleanLink.replace(/^@/, "");
        } else if (cleanLink.startsWith("t.me")) {
          cleanLink = "https://" + cleanLink;
        }

        const depositAddress = await getAdminDepositAddress(db);
        const memo = `TASK-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;

        const newTask = {
          creatorId: telegramId,
          type: taskType,
          title: title.trim(),
          link: cleanLink,
          reward: 10,
          targetCount: count,
          tonCost: tonCost,
          currency: "TON",
          depositAddress: depositAddress,
          memo: memo,
          completedBy: [],
          status: "pending_payment",
          paid: false,
          createdAt: Date.now()
        };

        const insertRes = await tasksCol.insertOne(newTask);
        const taskId = String(insertRes.insertedId);

        res.status(200).json({
          ok: true,
          requiresDeposit: true,
          deposit: {
            taskId: taskId,
            title: newTask.title,
            targetUsers: count,
            tonCost: tonCost,
            depositAddress: depositAddress,
            memo: memo
          },
          message: "Please complete the TON deposit to publish your task."
        });
        return;
      }

      // 3. CHECK DEPOSIT (Triggered by client polling, wallet confirmation, or manual check)
      if (action === "check_deposit") {
        const { taskId } = req.body || {};
        if (!taskId) {
          res.status(400).json({ error: "taskId is required" });
          return;
        }

        let objId;
        try { objId = new ObjectId(taskId); } catch(e) { objId = null; }
        const taskQuery = objId ? { _id: objId } : { _id: taskId };
        const task = await tasksCol.findOne(taskQuery);

        if (!task) {
          res.status(404).json({ error: "Task not found" });
          return;
        }

        if (task.status === "active" && task.paid) {
          res.status(200).json({
            ok: true,
            paid: true,
            status: "active",
            txHash: task.txHash || null,
            message: "Task is active and published!"
          });
          return;
        }

        // Check on-chain deposit
        const resCheck = await checkTonDeposit(task.depositAddress, task.tonCost, task.memo);
        if (resCheck.verified) {
          await tasksCol.updateOne(
            taskQuery,
            {
              $set: {
                status: "active",
                paid: true,
                paidAt: Date.now(),
                txHash: resCheck.txHash,
                sender: resCheck.sender || null
              }
            }
          );

          await notifyUserTaskActivated(botToken, telegramId, task, resCheck.txHash);

          res.status(200).json({
            ok: true,
            paid: true,
            status: "active",
            txHash: resCheck.txHash,
            message: "Payment confirmed! Your task is now active."
          });
          return;
        }

        res.status(200).json({
          ok: true,
          paid: false,
          status: "pending_payment",
          message: "Payment not detected on-chain yet. Please ensure you sent with the exact memo."
        });
        return;
      }

      res.status(400).json({ error: "Unknown action" });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("tasks.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
