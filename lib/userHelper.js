const { ObjectId } = require("mongodb");

async function findOrCreateUser(usersCol, tgUser) {
  if (!tgUser || !tgUser.id) return null;
  const telegramId = String(tgUser.id);
  const numId = Number(tgUser.id);

  const query = {
    $or: [
      { telegramId: telegramId },
      { telegramId: numId }
    ]
  };

  const matchingUsers = await usersCol.find(query).sort({ balance: -1, createdAt: 1 }).toArray();

  if (matchingUsers.length === 0) {
    const newUser = {
      telegramId: telegramId,
      firstName: tgUser.first_name || "",
      username: tgUser.username || "",
      photoUrl: tgUser.photo_url || "",
      balance: 0,
      minerLevel: 1,
      lastMineCollectedAt: null,
      dailyCycle: 1,
      dailyDayIndex: 0,
      lastCheckinAt: null,
      totalDailyEarned: 0,
      recruitsCount: 0,
      refEarnings: 0,
      referredBy: null,
      claimedMilestones: [],
      completedTasks: [],
      language: "en",
      languageSelected: false,
      createdAt: Date.now()
    };
    const res = await usersCol.insertOne(newUser);
    newUser._id = res.insertedId;
    return newUser;
  }

  let primaryUser = matchingUsers[0];

  // If duplicate documents exist, merge all progression fields
  if (matchingUsers.length > 1) {
    let maxBalance = Number(primaryUser.balance) || 0;
    let maxLevel = Number(primaryUser.minerLevel) || 1;
    let maxRecruits = Number(primaryUser.recruitsCount) || 0;
    let maxRefEarnings = Number(primaryUser.refEarnings) || 0;
    let maxDailyEarned = Number(primaryUser.totalDailyEarned) || 0;
    let dailyCycle = Number(primaryUser.dailyCycle) || 1;
    let dailyDayIndex = Number(primaryUser.dailyDayIndex) || 0;
    let claimedMilestones = Array.isArray(primaryUser.claimedMilestones) ? [...primaryUser.claimedMilestones] : [];
    let completedTasks = Array.isArray(primaryUser.completedTasks) ? [...primaryUser.completedTasks] : [];
    let referredBy = primaryUser.referredBy || null;
    let lastMine = primaryUser.lastMineCollectedAt;
    let lastCheckin = primaryUser.lastCheckinAt;

    for (let i = 1; i < matchingUsers.length; i++) {
      const other = matchingUsers[i];
      if ((Number(other.balance) || 0) > maxBalance) maxBalance = Number(other.balance);
      if ((Number(other.minerLevel) || 1) > maxLevel) maxLevel = Number(other.minerLevel);
      if ((Number(other.recruitsCount) || 0) > maxRecruits) maxRecruits = Number(other.recruitsCount);
      if ((Number(other.refEarnings) || 0) > maxRefEarnings) maxRefEarnings = Number(other.refEarnings);
      if ((Number(other.totalDailyEarned) || 0) > maxDailyEarned) maxDailyEarned = Number(other.totalDailyEarned);
      if ((Number(other.dailyCycle) || 1) > dailyCycle) {
        dailyCycle = Number(other.dailyCycle);
        dailyDayIndex = Number(other.dailyDayIndex) || 0;
      }
      if (!referredBy && other.referredBy) referredBy = other.referredBy;
      if (Array.isArray(other.claimedMilestones)) {
        other.claimedMilestones.forEach(m => {
          if (!claimedMilestones.includes(m)) claimedMilestones.push(m);
        });
      }
      if (Array.isArray(other.completedTasks)) {
        other.completedTasks.forEach(t => {
          if (!completedTasks.includes(t)) completedTasks.push(t);
        });
      }
      if (other.lastMineCollectedAt && (!lastMine || other.lastMineCollectedAt > lastMine)) {
        lastMine = other.lastMineCollectedAt;
      }
      if (other.lastCheckinAt && (!lastCheckin || other.lastCheckinAt > lastCheckin)) {
        lastCheckin = other.lastCheckinAt;
      }
      try {
        await usersCol.deleteOne({ _id: other._id });
      } catch (e) {
        console.error("Duplicate cleanup error:", e);
      }
    }

    primaryUser.balance = maxBalance;
    primaryUser.minerLevel = maxLevel;
    primaryUser.recruitsCount = maxRecruits;
    primaryUser.refEarnings = maxRefEarnings;
    primaryUser.totalDailyEarned = maxDailyEarned;
    primaryUser.dailyCycle = dailyCycle;
    primaryUser.dailyDayIndex = dailyDayIndex;
    primaryUser.claimedMilestones = claimedMilestones;
    primaryUser.completedTasks = completedTasks;
    primaryUser.referredBy = referredBy;
    if (lastMine) primaryUser.lastMineCollectedAt = lastMine;
    if (lastCheckin) primaryUser.lastCheckinAt = lastCheckin;
  }

  // Ensure telegramId is normalized to string, update any changed user profile fields
  const updateFields = { telegramId: telegramId };
  if (primaryUser.balance !== undefined) updateFields.balance = primaryUser.balance;
  if (primaryUser.minerLevel !== undefined) updateFields.minerLevel = primaryUser.minerLevel;
  if (primaryUser.lastMineCollectedAt !== undefined) updateFields.lastMineCollectedAt = primaryUser.lastMineCollectedAt;
  if (primaryUser.lastCheckinAt !== undefined) updateFields.lastCheckinAt = primaryUser.lastCheckinAt;
  if (primaryUser.recruitsCount !== undefined) updateFields.recruitsCount = primaryUser.recruitsCount;
  if (primaryUser.refEarnings !== undefined) updateFields.refEarnings = primaryUser.refEarnings;
  if (primaryUser.totalDailyEarned !== undefined) updateFields.totalDailyEarned = primaryUser.totalDailyEarned;
  if (primaryUser.dailyCycle !== undefined) updateFields.dailyCycle = primaryUser.dailyCycle;
  if (primaryUser.dailyDayIndex !== undefined) updateFields.dailyDayIndex = primaryUser.dailyDayIndex;
  if (primaryUser.claimedMilestones !== undefined) updateFields.claimedMilestones = primaryUser.claimedMilestones;
  if (primaryUser.completedTasks !== undefined) updateFields.completedTasks = primaryUser.completedTasks;
  if (primaryUser.referredBy !== undefined) updateFields.referredBy = primaryUser.referredBy;

  if (tgUser.first_name && primaryUser.firstName !== tgUser.first_name) {
    updateFields.firstName = tgUser.first_name;
    primaryUser.firstName = tgUser.first_name;
  }
  if (tgUser.username && primaryUser.username !== tgUser.username) {
    updateFields.username = tgUser.username;
    primaryUser.username = tgUser.username;
  }
  if (tgUser.photo_url && primaryUser.photoUrl !== tgUser.photo_url) {
    updateFields.photoUrl = tgUser.photo_url;
    primaryUser.photoUrl = tgUser.photo_url;
  }

  await usersCol.updateOne({ _id: primaryUser._id }, { $set: updateFields });
  return primaryUser;
}

async function findUserById(usersCol, tgId) {
  if (!tgId) return null;
  const sId = String(tgId);
  const nId = Number(tgId);
  const orList = [{ telegramId: sId }];
  if (!isNaN(nId)) {
    orList.push({ telegramId: nId });
  }
  return await usersCol.findOne({ $or: orList }, { sort: { balance: -1 } });
}

module.exports = {
  findOrCreateUser,
  findUserById
};
