// Shared reward-schedule / timing logic used by the API routes.
// Keeping this in one file means the mining and daily-bonus rules
// only ever live in one place.

const DAILY_REWARDS = [5, 10, 15, 20, 25, 30, 35]; // Increases by 5 every day (Day 1: 5 up to Day 7: 35)

const DAY_MS = 24 * 60 * 60 * 1000;
const MINE_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MINE_REWARD = 80;

function rewardForCycleDay(cycle, dayIndex) {
  // dayIndex is 0-based (0..6)
  return DAILY_REWARDS[dayIndex] || ((dayIndex + 1) * 5);
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
  DAILY_REWARDS,
  DAY_MS,
  MINE_INTERVAL_MS,
  MINE_REWARD,
  rewardForCycleDay,
  dailyStatus,
  mineIsReady
};
