const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { ObjectId } = require("mongodb");

const DEFAULT_TASKS = [
  {
    _id: "default_1",
    type: "verified",
    title: "HOOCOOH Announcement",
    link: "https://t.me/hoocooh_miner",
    reward: 10,
    targetCount: 10000,
    completedBy: []
  },
  {
    _id: "default_2",
    type: "verified",
    title: "HOOCOOH Community Chat",
    link: "https://t.me/hoocooh_chat",
    reward: 10,
    targetCount: 10000,
    completedBy: []
  },
  {
    _id: "default_3",
    type: "normal",
    title: "Crypto Binaca Airdrop",
    link: "https://t.me/CryptoBinaca",
    reward: 10,
    targetCount: 5000,
    completedBy: []
  },
  {
    _id: "default_4",
    type: "normal",
    title: "Airdrop Titans Community",
    link: "https://t.me/AirdropTitans",
    reward: 10,
    targetCount: 5000,
    completedBy: []
  }
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
    const tasksCol = db.collection("tasks");
    const usersCol = db.collection("users");

    // GET: list tasks
    if (req.method === "GET") {
      const user = await usersCol.findOne({ telegramId });
      const userCompleted = (user && user.completedTasks) || [];

      // Find custom active tasks
      const customTasks = await tasksCol.find({ status: { $ne: "disabled" } }).sort({ createdAt: -1 }).toArray();
      const allTasks = [...DEFAULT_TASKS, ...customTasks];

      const mapped = allTasks.map(t => {
        const idStr = String(t._id);
        const completedArr = t.completedBy || [];
        const isCompleted = userCompleted.includes(idStr) || completedArr.includes(telegramId);
        return {
          id: idStr,
          type: t.type || "normal",
          title: t.title,
          link: t.link,
          reward: 10,
          targetCount: t.targetCount || 100,
          completedCount: completedArr.length,
          isCompleted
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

        const user = await usersCol.findOne({ telegramId });
        const userCompleted = (user && user.completedTasks) || [];
        if (userCompleted.includes(String(taskId))) {
          res.status(400).json({ error: "Task already claimed" });
          return;
        }

        let taskObj = DEFAULT_TASKS.find(d => d._id === taskId);
        let taskQuery = null;

        if (!taskObj) {
          let objId;
          try { objId = new ObjectId(taskId); } catch(e) { objId = null; }
          taskQuery = objId ? { _id: objId } : { _id: taskId };
          taskObj = await tasksCol.findOne(taskQuery);
        }

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

        const currentBal = user ? Number(user.balance || 0) : 0;
        const newBal = currentBal + 10;

        await usersCol.updateOne(
          { telegramId },
          {
            $set: { balance: newBal },
            $addToSet: { completedTasks: String(taskId) }
          },
          { upsert: true }
        );

        res.status(200).json({ ok: true, reward: 10, newBalance: newBal });
        return;
      }

      // 2. CREATE
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

        const user = await usersCol.findOne({ telegramId });
        const userBal = user ? Number(user.balance || 0) : 0;

        const newTask = {
          creatorId: telegramId,
          type: taskType,
          title: title.trim(),
          link: cleanLink,
          reward: 10,
          targetCount: count,
          tonCost: tonCost,
          currency: "TON",
          completedBy: [],
          status: "active",
          createdAt: Date.now()
        };

        const insertRes = await tasksCol.insertOne(newTask);

        res.status(200).json({
          ok: true,
          task: {
            id: String(insertRes.insertedId),
            ...newTask
          },
          newBalance: userBal,
          message: `Task successfully posted! Sponsored ${count} users (${tonCost} TON).`
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
