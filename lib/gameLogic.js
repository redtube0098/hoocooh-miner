// Shared reward-schedule / timing logic used by the API routes.
// Keeping this in one file means the mining and daily-bonus rules
// only ever live in one place.

const WEEK1_REWARDS = [2, 5, 10, 20, 40, 80, 160];   // first ever streak week
const REPEAT_REWARDS = [10, 10, 10, 15, 15, 15, 30]; // every week after that

const DAY_MS = 24 * 60 * 60 * 1000;
const MINE_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MINE_REWARD = 80;

function rewardForCycleDay(cycle, dayIndex) {
  // dayIndex is 0-based (0..6)
  return cycle === 1 ? WEEK1_REWARDS[dayIndex] : REPEAT_REWARDS[dayIndex];
}

// "ready"   -> user can check in right now (first time, or 24h+ have passed but < 48h)
// "waiting" -> not yet 24h since last check-in
// "broken"  -> 48h+ have passed, streak is broken and restarts at day 1
function dailyStatus(lastCheckinAt) {
  if (!lastCheckinAt) return "ready";
  const elapsed = Date.now() - lastCheckinAt;
  if (elapsed < DAY_MS) return "waiting";
  if (elapsed >= 2 * DAY_MS) return "broken";
  return "ready";
}

function mineIsReady(lastMineCollectedAt) {
  if (!lastMineCollectedAt) return true;
  return (Date.now() - lastMineCollectedAt) >= MINE_INTERVAL_MS;
}

module.exports = {
  WEEK1_REWARDS,
  REPEAT_REWARDS,
  DAY_MS,
  MINE_INTERVAL_MS,
  MINE_REWARD,
  rewardForCycleDay,
  dailyStatus,
  mineIsReady
};
