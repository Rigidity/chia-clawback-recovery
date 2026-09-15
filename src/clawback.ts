import { Address, ClawbackV2, Clvm, bytesEqual, toHex } from "chia-wallet-sdk";
import type {
  CoinRecord,
  CoinSpend,
  PublicKey,
  RpcClient,
} from "chia-wallet-sdk";

const MAX_BLOCK_COST = 11_000_000_000n;

export interface DiscoveredClawback {
  clawback: ClawbackV2;
  records: CoinRecord[];
}

export interface UnsignedCoinSpends {
  coinSpends: ReturnType<typeof coinSpendJson>[];
  inputAmount: bigint;
  outputAmount: bigint;
}

export function decodeMainnetAddress(value: string, label: string): Address {
  let address: Address;
  try {
    address = Address.decode(value);
  } catch {
    throw new Error(`${label} is not a valid address`);
  }
  if (address.prefix !== "xch") {
    throw new Error(`${label} must use the xch mainnet prefix`);
  }
  return address;
}

function coinSpendJson(coinSpend: CoinSpend) {
  return {
    coin: {
      parent_coin_info: toHex(coinSpend.coin.parentCoinInfo),
      puzzle_hash: toHex(coinSpend.coin.puzzleHash),
      amount: coinSpend.coin.amount.toString(),
    },
    puzzle_reveal: toHex(coinSpend.puzzleReveal),
    solution: toHex(coinSpend.solution),
  };
}

async function parseClawbackFromRecord(
  client: RpcClient,
  record: CoinRecord,
  expectedPuzzleHash: Uint8Array,
): Promise<ClawbackV2 | null> {
  const response = await client.getPuzzleAndSolution(
    record.coin.parentCoinInfo,
    record.confirmedBlockIndex,
  );
  if (!response.success || !response.coinSolution) {
    return null;
  }

  const clvm = new Clvm();
  const parentPuzzle = clvm.deserialize(response.coinSolution.puzzleReveal);
  const parentSolution = clvm.deserialize(response.coinSolution.solution);
  const conditions = parentPuzzle
    .run(parentSolution, MAX_BLOCK_COST, false)
    .value.toList();
  if (!conditions) {
    return null;
  }

  const createCoin = conditions
    .map((condition) => condition.parseCreateCoin())
    .find(
      (created) =>
        created !== null &&
        created.amount === record.coin.amount &&
        bytesEqual(created.puzzleHash, record.coin.puzzleHash),
    );
  const memos = createCoin?.memos?.toList();
  const receiverPuzzleHash = memos?.[0]?.toAtom();
  if (
    !createCoin ||
    !memos ||
    memos.length < 2 ||
    !receiverPuzzleHash ||
    receiverPuzzleHash.length !== 32
  ) {
    return null;
  }

  for (const hinted of [false, true]) {
    try {
      const clawback = ClawbackV2.fromMemo(
        memos[1]!,
        receiverPuzzleHash,
        createCoin.amount,
        hinted,
        expectedPuzzleHash,
      );
      if (clawback) {
        return clawback;
      }
    } catch {
      // This record's memos are not a valid clawback for this wrapper.
    }
  }

  return null;
}

async function discoverClawback(
  client: RpcClient,
  puzzleHash: Uint8Array,
  records: CoinRecord[],
): Promise<ClawbackV2> {
  for (const record of records) {
    const clawback = await parseClawbackFromRecord(client, record, puzzleHash);
    if (clawback) {
      return clawback;
    }
  }
  throw new Error(
    "Could not reconstruct the Clawback V2 puzzle from this address's coin history",
  );
}

export async function discoverCoins(
  client: RpcClient,
  clawbackAddress: Address,
  requestedCoinIds?: string[],
): Promise<DiscoveredClawback> {
  const response = await client.getCoinRecordsByPuzzleHash(
    clawbackAddress.puzzleHash,
    null,
    null,
    true,
  );
  if (!response.success) {
    throw new Error(
      `Coinset address lookup failed: ${response.error ?? "unknown error"}`,
    );
  }

  const records = response.coinRecords ?? [];
  const clawback = await discoverClawback(
    client,
    clawbackAddress.puzzleHash,
    records,
  );
  const requested = requestedCoinIds ? new Set(requestedCoinIds) : null;
  const unspent = records.filter(
    (record) =>
      !record.spent &&
      (!requested || requested.has(toHex(record.coin.coinId()))),
  );

  if (unspent.length === 0) {
    throw new Error("No matching unspent coins exist at the clawback address");
  }
  if (requested && unspent.length !== requested.size) {
    const found = new Set(unspent.map((record) => toHex(record.coin.coinId())));
    const missing = [...requested].filter((coinId) => !found.has(coinId));
    throw new Error(
      `Requested coins are missing or spent: ${missing.join(", ")}`,
    );
  }
  if (BigInt(Math.floor(Date.now() / 1_000)) < clawback.seconds) {
    throw new Error(
      `Clawback receiver path is timelocked until ${clawback.seconds}`,
    );
  }

  return { clawback, records: unspent };
}

export function buildUnsignedCoinSpends(
  clawback: ClawbackV2,
  records: CoinRecord[],
  receiverPublicKey: PublicKey,
  destination: Address,
  fee: bigint,
): UnsignedCoinSpends {
  const total = records.reduce((sum, record) => sum + record.coin.amount, 0n);
  if (fee >= total) {
    throw new Error(`Fee ${fee} must be less than recovered amount ${total}`);
  }

  const outputAmount = total - fee;
  const clvm = new Clvm();

  records.forEach((record, index) => {
    const conditions =
      index === 0
        ? [
            clvm.createCoin(
              destination.puzzleHash,
              outputAmount,
              clvm.list([clvm.atom(destination.puzzleHash)]),
            ),
            ...(fee > 0n ? [clvm.reserveFee(fee)] : []),
          ]
        : [];
    const standardSpend = clvm.standardSpend(
      receiverPublicKey,
      clvm.delegatedSpend(conditions),
    );
    clvm.spendCoin(record.coin, clawback.receiverSpend(standardSpend));
  });

  const coinSpends = clvm.coinSpends();
  if (coinSpends.length !== records.length) {
    throw new Error("Failed to build every requested clawback coin spend");
  }

  return {
    coinSpends: coinSpends.map(coinSpendJson),
    inputAmount: total,
    outputAmount,
  };
}
