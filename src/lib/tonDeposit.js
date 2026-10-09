const { mnemonicToPrivateKey } = require("@ton/crypto");
const { WalletContractV4, WalletContractV5R1 } = require("@ton/ton");

function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

let cachedDerivedAddress = null;

async function getAdminDepositAddress(db) {
  // 1. Direct environment variable
  const envAddr = (process.env.ADMIN_TON_ADDRESS || process.env.TON_DEPOSIT_ADDRESS || "").trim();
  if (envAddr) return envAddr;

  // 2. Database settings
  if (db) {
    try {
      const setting = await db.collection("settings").findOne({ key: "bot_settings" });
      if (setting && setting.depositTonAddress && String(setting.depositTonAddress).trim()) {
        return String(setting.depositTonAddress).trim();
      }
    } catch (e) {
      console.warn("getAdminDepositAddress DB lookup warning:", e.message);
    }
  }

  // 3. Derived from hot wallet mnemonic if provided
  if (cachedDerivedAddress) return cachedDerivedAddress;
  const mnemonicStr = process.env.TON_WALLET_MNEMONIC;
  if (mnemonicStr) {
    try {
      const words = mnemonicStr.trim().split(/\s+/).filter(Boolean);
      if (words.length === 24 || words.length === 12) {
        const keyPair = await mnemonicToPrivateKey(words);
        const wallet = WalletContractV5R1
          ? WalletContractV5R1.create({ workchain: 0, publicKey: keyPair.publicKey })
          : WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
        const derived = wallet.address.toString({ bounceable: false });
        cachedDerivedAddress = derived;
        return derived;
      }
    } catch (deriveErr) {
      console.warn("Mnemonic address derivation warning:", deriveErr.message);
    }
  }

  // 4. Default fallback admin wallet address
  return "UQBAXn8r6wB789V89rPjB6qQyJ8v8j5Qv8j5Qv8j5Qv8j5Qv";
}

/**
 * Check if a real TON deposit arrived on-chain matching the memo & amount
 */
async function checkTonDeposit(depositAddress, expectedAmountTon, expectedMemo) {
  if (!depositAddress || !expectedMemo) {
    return { verified: false, reason: "Missing address or memo" };
  }

  const cleanMemo = String(expectedMemo).trim();
  const targetTon = Number(expectedAmountTon) || 0;
  const rawKey = (process.env.TONCENTER_API_KEY || process.env.TON_API_KEY || process.env.TON_CONSOLE_API_KEY || "").trim();
  const validToncenterKey = /^[0-9a-fA-F]{64}$/.test(rawKey) ? rawKey : undefined;

  // Attempt 1: Toncenter v2 API
  try {
    const url = `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(depositAddress)}&limit=30`;
    const headers = {};
    if (validToncenterKey) {
      headers["X-API-Key"] = validToncenterKey;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json();
      const txs = data && data.result ? data.result : [];

      for (const tx of txs) {
        const inMsg = tx.in_msg;
        if (!inMsg) continue;

        // Extract comment / memo from message
        let memoInTx = "";
        if (inMsg.message && typeof inMsg.message === "string") {
          memoInTx = inMsg.message;
        } else if (inMsg.msg_data && inMsg.msg_data.text) {
          memoInTx = inMsg.msg_data.text;
        }

        if (memoInTx && memoInTx.includes(cleanMemo)) {
          const valueNano = Number(inMsg.value || 0);
          const tonReceived = valueNano / 1e9;

          // Check amount with 2% margin for gas or small fees
          if (tonReceived >= (targetTon * 0.98)) {
            const txHash = tx.transaction_id ? (tx.transaction_id.hash || `${tx.transaction_id.lt}:${tx.transaction_id.hash}`) : (tx.hash || "ton_confirmed");
            return {
              verified: true,
              txHash: String(txHash),
              sender: inMsg.source || "",
              tonReceived
            };
          }
        }
      }
    }
  } catch (tcErr) {
    console.warn("Toncenter checkTonDeposit warning:", tcErr.message);
  }

  // Attempt 2: TonAPI.io fallback
  try {
    const tonApiUrl = `https://tonapi.io/v2/blockchain/accounts/${encodeURIComponent(depositAddress)}/transactions?limit=30`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(tonApiUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json();
      const txs = (data && data.transactions) ? data.transactions : [];

      for (const tx of txs) {
        const inMsg = tx.in_msg;
        if (!inMsg) continue;

        let memoInTx = "";
        if (inMsg.decoded_body && inMsg.decoded_body.text) {
          memoInTx = inMsg.decoded_body.text;
        } else if (inMsg.message) {
          memoInTx = inMsg.message;
        }

        if (memoInTx && memoInTx.includes(cleanMemo)) {
          const valueNano = Number(inMsg.value || 0);
          const tonReceived = valueNano / 1e9;

          if (tonReceived >= (targetTon * 0.98)) {
            return {
              verified: true,
              txHash: tx.hash || "tonapi_confirmed",
              sender: inMsg.source ? (inMsg.source.address || inMsg.source) : "",
              tonReceived
            };
          }
        }
      }
    }
  } catch (apiErr) {
    console.warn("TonAPI checkTonDeposit warning:", apiErr.message);
  }

  return { verified: false, reason: "No matching on-chain transaction found yet" };
}

/**
 * Send celebratory confirmation message to user's Telegram chat
 */
async function notifyUserTaskActivated(botToken, telegramId, task, txHash) {
  if (!botToken || !telegramId || !task) return;
  try {
    const text =
      `💎 <b>PAYMENT CONFIRMED! TASK ACTIVATED</b>\n\n` +
      `Your sponsored task has been published successfully:\n\n` +
      `📌 <b>Task:</b> ${escapeHtml(task.title)}\n` +
      `👥 <b>Target Audience:</b> ${Number(task.targetCount).toLocaleString()} users\n` +
      `💰 <b>Amount Paid:</b> ${task.tonCost} TON\n` +
      `🔖 <b>Order Memo:</b> <code>${escapeHtml(task.memo)}</code>\n` +
      (txHash ? `🔗 <b>Tx Hash:</b> <code>${escapeHtml(txHash)}</code>\n\n` : `\n`) +
      `<i>Real miners are now completing your task and joining your channel! 🚀</i>`;

    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: String(telegramId),
        text,
        parse_mode: "HTML"
      })
    });
  } catch (e) {
    console.error("notifyUserTaskActivated error:", e.message);
  }
}

module.exports = {
  getAdminDepositAddress,
  checkTonDeposit,
  notifyUserTaskActivated
};
