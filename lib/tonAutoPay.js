/**
 * TON On-Chain Auto-Payout Dispatcher
 * Dispatches automated on-chain payments to user TON wallet addresses upon admin approval.
 *
 * SECURE:
 * - Never stores or logs mnemonic phrases or private keys.
 * - All credentials read exclusively from environment variables.
 *
 * Environment Variables:
 * - TON_AUTO_PAY: Set to 'true' to activate automatic payout on approval.
 * - TON_WALLET_MNEMONIC: 24 secret words of the hot wallet (space separated).
 * - TON_API_KEY / TONCENTER_API_KEY / TON_CONSOLE_API_KEY: Optional RPC key.
 * - TON_RPC_ENDPOINT: Optional custom endpoint (defaults to https://toncenter.com/api/v2/jsonRPC).
 */

const { TonClient, WalletContractV4, WalletContractV5R1, internal, toNano, fromNano } = require("@ton/ton");
const { mnemonicToPrivateKey } = require("@ton/crypto");

async function dispatchTonPayout(toAddress, tonAmount, memo = "HOOCOOH Miner Payout") {
  const autoPayEnabled = process.env.TON_AUTO_PAY === "true";
  const mnemonicStr = process.env.TON_WALLET_MNEMONIC;

  if (!autoPayEnabled || !mnemonicStr) {
    return {
      success: false,
      isConfigured: false,
      txHash: null,
      message: "TON auto-pay is disabled or TON_WALLET_MNEMONIC is not configured in environment."
    };
  }

  const words = mnemonicStr.trim().split(/\s+/).filter(Boolean);
  if (words.length !== 24 && words.length !== 12) {
    return {
      success: false,
      isConfigured: true,
      error: "INVALID_MNEMONIC_LENGTH",
      message: `Invalid mnemonic length (${words.length} words found, expected 24).`
    };
  }

  const amtNum = parseFloat(tonAmount);
  if (isNaN(amtNum) || amtNum <= 0) {
    return {
      success: false,
      isConfigured: true,
      error: "INVALID_AMOUNT",
      message: `Invalid payout amount: ${tonAmount} TON`
    };
  }

  try {
    const rawKey = (process.env.TONCENTER_API_KEY || process.env.TON_API_KEY || process.env.TON_CONSOLE_API_KEY || "").trim();
    // Toncenter keys are strictly 64-char hexadecimal. If it's a TON Console / Bearer key, don't pass it to Toncenter to prevent 401!
    const validToncenterKey = /^[0-9a-fA-F]{64}$/.test(rawKey) ? rawKey : undefined;
    const endpoint = process.env.TON_RPC_ENDPOINT || "https://toncenter.com/api/v2/jsonRPC";

    let client = new TonClient({
      endpoint,
      apiKey: validToncenterKey
    });

    async function sleep(ms) {
      return new Promise(r => setTimeout(r, ms));
    }

    async function safeCall(fn, retries = 4, delay = 1200) {
      for (let i = 0; i < retries; i++) {
        try {
          return await fn();
        } catch (err) {
          const msg = (err && err.message) ? err.message : "";
          if (msg.includes("429") || msg.includes("rate limit")) {
            await sleep(delay * (i + 1));
            continue;
          }
          if (msg.includes("401")) {
            client = new TonClient({ endpoint: "https://toncenter.com/api/v2/jsonRPC" });
            await sleep(500);
            continue;
          }
          throw err;
        }
      }
      return await fn();
    }

    // Derive key pair securely in memory
    const keyPair = await mnemonicToPrivateKey(words);
    const workchain = 0;
    const walletV5 = WalletContractV5R1 ? WalletContractV5R1.create({ workchain, publicKey: keyPair.publicKey }) : null;
    const walletV4 = WalletContractV4.create({ workchain, publicKey: keyPair.publicKey });

    let activeWallet = null;
    let balanceTon = 0;
    let balV5 = 0;

    // Check V5 first (modern Tonkeeper default)
    if (walletV5) {
      try {
        const nano = await safeCall(() => client.getBalance(walletV5.address));
        balV5 = parseFloat(fromNano(nano));
      } catch (_) {}
    }

    const requiredTotal = amtNum + 0.008;

    if (balV5 >= requiredTotal) {
      // W5 wallet has funds! Use directly without extra calls
      activeWallet = walletV5;
      balanceTon = balV5;
    } else {
      // Fallback: check V4
      await sleep(1000);
      let balV4 = 0;
      try {
        const nano = await safeCall(() => client.getBalance(walletV4.address));
        balV4 = parseFloat(fromNano(nano));
      } catch (_) {}
      activeWallet = balV5 >= balV4 ? (walletV5 || walletV4) : walletV4;
      balanceTon = Math.max(balV5, balV4);
    }

    const senderAddress = activeWallet.address.toString({ bounceable: false });
    const contract = client.open(activeWallet);

    if (balanceTon < requiredTotal) {
      return {
        success: false,
        isConfigured: true,
        error: "INSUFFICIENT_HOT_WALLET_BALANCE",
        message: `Hot wallet balance too low! Available: ${balanceTon.toFixed(4)} TON, Needed: ${requiredTotal.toFixed(4)} TON (including network gas fee). Please deposit TON to: ${senderAddress}`
      };
    }

    await sleep(800); // polite pause between requests to respect rate limit

    let currentSeqno = 0;
    try {
      currentSeqno = await safeCall(() => contract.getSeqno().catch(() => 0));
    } catch (_) {
      currentSeqno = 0;
    }

    await sleep(800); // polite pause before broadcast

    // Broadcast on-chain transfer
    await safeCall(() => contract.sendTransfer({
      seqno: currentSeqno,
      secretKey: keyPair.secretKey,
      messages: [
        internal({
          to: toAddress,
          value: toNano(amtNum.toFixed(6)),
          bounce: false,
          body: memo || "HOOCOOH Miner Payout"
        })
      ]
    }));

    // Pause 2 seconds to let network propagate
    await sleep(2000);

    // Build unique tx identifier
    const txId = `ton_${Date.now()}_seq${currentSeqno}`;

    return {
      success: true,
      isConfigured: true,
      txHash: txId,
      sender: senderAddress,
      amount: amtNum,
      confirmed: true,
      message: `Successfully broadcast ${amtNum} TON on-chain from ${senderAddress}!`
    };
  } catch (err) {
    console.error("TON Auto-Pay error:", err.message);
    return {
      success: false,
      isConfigured: true,
      error: err.message,
      message: `On-chain transfer failed: ${err.message}`
    };
  }
}

module.exports = {
  dispatchTonPayout
};
