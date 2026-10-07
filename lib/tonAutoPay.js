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

const { TonClient, WalletContractV4, internal, toNano, fromNano } = require("@ton/ton");
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

    // Derive key pair securely in memory
    const keyPair = await mnemonicToPrivateKey(words);
    const workchain = 0;
    const wallet = WalletContractV4.create({ workchain, publicKey: keyPair.publicKey });
    let contract = client.open(wallet);

    // Verify wallet deployment and balance (with auto-recovery from 401)
    const senderAddress = wallet.address.toString({ bounceable: false });
    let balanceNano;
    try {
      balanceNano = await client.getBalance(wallet.address);
    } catch (netErr) {
      if (netErr.message && netErr.message.includes("401")) {
        // Fallback: switch to public TonCenter without apiKey
        client = new TonClient({ endpoint: "https://toncenter.com/api/v2/jsonRPC" });
        contract = client.open(wallet);
        balanceNano = await client.getBalance(wallet.address);
      } else {
        throw netErr;
      }
    }

    const balanceTon = parseFloat(fromNano(balanceNano));

    // Gas reserve: ~0.008 TON
    const requiredTotal = amtNum + 0.008;
    if (balanceTon < requiredTotal) {
      return {
        success: false,
        isConfigured: true,
        error: "INSUFFICIENT_HOT_WALLET_BALANCE",
        message: `Hot wallet balance too low! Available: ${balanceTon.toFixed(4)} TON, Needed: ${requiredTotal.toFixed(4)} TON (including network gas fee). Please deposit TON to: ${senderAddress}`
      };
    }

    let currentSeqno = 0;
    try {
      currentSeqno = await contract.getSeqno();
    } catch (_) {
      currentSeqno = 0;
    }

    // Broadcast on-chain transfer
    await contract.sendTransfer({
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
    });

    // Wait up to 15 seconds for confirmation (seqno increment)
    let confirmed = false;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const nextSeqno = await contract.getSeqno();
        if (nextSeqno > currentSeqno) {
          confirmed = true;
          break;
        }
      } catch (_) {}
    }

    // Build unique tx identifier
    const txId = `ton_${Date.now()}_seq${currentSeqno}`;

    return {
      success: true,
      isConfigured: true,
      txHash: txId,
      sender: senderAddress,
      amount: amtNum,
      confirmed,
      message: confirmed 
        ? `Successfully sent ${amtNum} TON on-chain! Confirmed at seqno ${currentSeqno + 1}`
        : `Sent ${amtNum} TON to blockchain mempool (seqno: ${currentSeqno}). Processing.`
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
