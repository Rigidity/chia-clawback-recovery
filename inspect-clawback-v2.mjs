import { createRequire } from "node:module";

import { Command } from "commander";

const require = createRequire(import.meta.url);
const {
  Address,
  ClawbackV2,
  Clvm,
  RpcClient,
  bytesEqual,
  fromHex,
  toHex,
} = require("chia-wallet-sdk");

const MAX_BLOCK_COST = 11_000_000_000n;

const program = new Command()
  .name("inspect-clawback-v2")
  .description("Inspect a potential Clawback V2 coin through Coinset.")
  .requiredOption("-c, --coin-id <coinId>", "Coin ID to inspect")
  .option("--coinset-url <url>", "Coinset-compatible full node URL")
  .parse();

const options = program.opts();

function normalizeCoinId(value) {
  const hex = value.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`Invalid coin ID: ${value}`);
  }
  return hex;
}

function requireResult(response, label, property) {
  if (!response.success || !response[property]) {
    throw new Error(`${label} failed: ${response.error ?? "no result returned"}`);
  }
  return response[property];
}

function isoTime(timestamp) {
  return new Date(Number(timestamp) * 1_000).toISOString();
}

function formatXch(mojos) {
  const whole = mojos / 1_000_000_000_000n;
  const fraction = (mojos % 1_000_000_000_000n)
    .toString()
    .padStart(12, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction} XCH` : `${whole} XCH`;
}

async function blockTimestamp(client, height) {
  const response = await client.getBlockRecordByHeight(height);
  const record = requireResult(response, `block ${height}`, "blockRecord");
  if (record.timestamp === null) {
    throw new Error(`Block ${height} has no timestamp`);
  }
  return record.timestamp;
}

function parseClawback(createCoin, expectedPuzzleHash) {
  const memos = createCoin.memos?.toList();
  if (!memos || memos.length < 2) {
    return null;
  }

  const receiverPuzzleHash = memos[0].toAtom();
  if (!receiverPuzzleHash || receiverPuzzleHash.length !== 32) {
    return null;
  }

  for (const hinted of [false, true]) {
    const clawback = ClawbackV2.fromMemo(
      memos[1],
      receiverPuzzleHash,
      createCoin.amount,
      hinted,
      expectedPuzzleHash,
    );
    if (clawback) {
      return { clawback, hinted };
    }
  }

  return null;
}

async function inspectCoin(coinIdHex, client) {
  const networkResponse = await client.getNetworkInfo();
  if (!networkResponse.success || networkResponse.networkName !== "mainnet") {
    throw new Error(
      `Expected mainnet, got ${networkResponse.networkName ?? networkResponse.error ?? "unknown"}`,
    );
  }

  const coinId = fromHex(coinIdHex);
  const coinRecord = requireResult(
    await client.getCoinRecordByName(coinId),
    "coin lookup",
    "coinRecord",
  );
  const coin = coinRecord.coin;
  if (!bytesEqual(coin.coinId(), coinId)) {
    throw new Error("Coinset returned a record with a different coin ID");
  }

  const parentSpend = requireResult(
    await client.getPuzzleAndSolution(
      coin.parentCoinInfo,
      coinRecord.confirmedBlockIndex,
    ),
    "parent spend lookup",
    "coinSolution",
  );

  const clvm = new Clvm();
  const parentPuzzle = clvm.deserialize(parentSpend.puzzleReveal);
  const parentSolution = clvm.deserialize(parentSpend.solution);
  const output = parentPuzzle.run(parentSolution, MAX_BLOCK_COST, false);
  const conditions = output.value.toList();
  if (!conditions) {
    throw new Error("Parent spend returned an improper condition list");
  }

  const matchingCreateCoins = conditions
    .map((condition) => condition.parseCreateCoin())
    .filter(
      (created) =>
        created !== null &&
        created.amount === coin.amount &&
        bytesEqual(created.puzzleHash, coin.puzzleHash),
    );
  if (matchingCreateCoins.length !== 1) {
    throw new Error(
      `Expected one matching CREATE_COIN, found ${matchingCreateCoins.length}`,
    );
  }

  const parsed = parseClawback(matchingCreateCoins[0], coin.puzzleHash);
  if (!parsed) {
    return {
      network: networkResponse.networkName,
      coinId: `0x${coinIdHex}`,
      isClawbackV2: false,
      reason:
        "The creation memos do not parse as a clawback v2 whose derived puzzle hash matches the coin.",
    };
  }

  const { clawback, hinted } = parsed;
  const createdAt = await blockTimestamp(
    client,
    coinRecord.confirmedBlockIndex,
  );
  const expiresAt = clawback.seconds;
  const now = BigInt(Math.floor(Date.now() / 1_000));

  let state;
  if (!coinRecord.spent) {
    state = {
      status: "unspent",
      spendablePath:
        now < expiresAt ? "sender (before expiration)" : "receiver (after expiration)",
      expired: now >= expiresAt,
    };
  } else {
    const spentAt = await blockTimestamp(client, coinRecord.spentBlockIndex);
    const spend = requireResult(
      await client.getPuzzleAndSolution(coinId, coinRecord.spentBlockIndex),
      "coin spend lookup",
      "coinSolution",
    );
    const expectedPushThrough = clawback.pushThroughSpend(new Clvm());
    const wasPushedThrough =
      bytesEqual(expectedPushThrough.puzzle.serialize(), spend.puzzleReveal) &&
      bytesEqual(expectedPushThrough.solution.serialize(), spend.solution);

    const childrenResponse = await client.getCoinRecordsByParentIds(
      [coinId],
      null,
      null,
      true,
    );
    if (!childrenResponse.success) {
      throw new Error(
        `child coin lookup failed: ${childrenResponse.error ?? "unknown error"}`,
      );
    }
    const children = childrenResponse.coinRecords ?? [];

    state = {
      status: "spent",
      spentHeight: coinRecord.spentBlockIndex,
      spentAt: spentAt.toString(),
      spentAtIso: isoTime(spentAt),
      spentAfterExpiration: spentAt >= expiresAt,
      spendType: wasPushedThrough ? "push-through to receiver" : "sender or receiver spend",
      children: children.map((child) => ({
        coinId: `0x${toHex(child.coin.coinId())}`,
        puzzleHash: `0x${toHex(child.coin.puzzleHash)}`,
        amountMojos: child.coin.amount.toString(),
        amountXch: formatXch(child.coin.amount),
        spent: child.spent,
      })),
    };
  }

  return {
    network: networkResponse.networkName,
    coinsetUrl: client.baseUrl(),
    coinId: `0x${coinIdHex}`,
    isClawbackV2: true,
    coin: {
      parentCoinId: `0x${toHex(coin.parentCoinInfo)}`,
      puzzleHash: `0x${toHex(coin.puzzleHash)}`,
      amountMojos: coin.amount.toString(),
      amountXch: formatXch(coin.amount),
      confirmedHeight: coinRecord.confirmedBlockIndex,
      createdAt: createdAt.toString(),
      createdAtIso: isoTime(createdAt),
    },
    clawback: {
      senderPuzzleHash: `0x${toHex(clawback.senderPuzzleHash)}`,
      senderAddress: new Address(clawback.senderPuzzleHash, "xch").encode(),
      receiverPuzzleHash: `0x${toHex(clawback.receiverPuzzleHash)}`,
      receiverAddress: new Address(clawback.receiverPuzzleHash, "xch").encode(),
      expiresAt: expiresAt.toString(),
      expiresAtIso: isoTime(expiresAt),
      secondsFromCreation: (expiresAt - createdAt).toString(),
      hinted,
      derivedPuzzleHash: `0x${toHex(clawback.puzzleHash())}`,
    },
    state,
  };
}

try {
  const coinId = normalizeCoinId(options.coinId);
  const client = options.coinsetUrl
    ? new RpcClient(options.coinsetUrl)
    : RpcClient.mainnet();
  const result = await inspectCoin(coinId, client);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
