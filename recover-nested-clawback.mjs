import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import https from "node:https";

import { Command, InvalidArgumentError } from "commander";
import {
  Address,
  ClawbackV2,
  Clvm,
  Coin,
  PublicKey,
  RpcClient,
  bytesEqual,
  fromHex,
  standardPuzzleHash,
  toHex,
} from "chia-wallet-sdk";

const DEFAULT_RPC_DIRECTORY = resolve(
  homedir(),
  "Library/Application Support/com.rigidnetwork.sage",
);
const MAX_BLOCK_COST = 11_000_000_000n;

function parseNonNegativeBigInt(value) {
  let parsed;
  try {
    parsed = BigInt(value);
  } catch {
    throw new InvalidArgumentError("must be an integer");
  }
  if (parsed < 0n) {
    throw new InvalidArgumentError("must not be negative");
  }
  return parsed;
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return parsed;
}

function normalizeCoinId(value) {
  const hex = value.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new InvalidArgumentError(`invalid coin ID: ${value}`);
  }
  return hex;
}

const program = new Command()
  .name("recover-nested-clawback")
  .description(
    "Build receiver-path spends for unspent XCH at a Clawback V2 address, then sign and optionally submit them through Sage RPC.",
  )
  .requiredOption(
    "-a, --clawback-address <address>",
    "Clawback wrapper address containing the stuck XCH",
  )
  .option(
    "-d, --destination <address>",
    "Custody address for the recovered XCH (defaults to the clawback receiver)",
  )
  .option(
    "-f, --fee <mojos>",
    "Fee deducted from the recovered amount (default: 0)",
    parseNonNegativeBigInt,
  )
  .option(
    "--coin-id <coinIds...>",
    "Only recover specific coin IDs at the clawback address",
    (value, previous = []) => [...previous, normalizeCoinId(value)],
  )
  .option("--coinset-url <url>", "Coinset-compatible full node URL")
  .option("--rpc-url <url>", "Sage RPC base URL", "https://127.0.0.1:9257")
  .option(
    "--rpc-cert <path>",
    "Sage RPC client certificate",
    resolve(DEFAULT_RPC_DIRECTORY, "ssl/wallet.crt"),
  )
  .option(
    "--rpc-key <path>",
    "Sage RPC client private key",
    resolve(DEFAULT_RPC_DIRECTORY, "ssl/wallet.key"),
  )
  .option("--rpc-ca <path>", "Optional CA certificate for RPC verification")
  .option(
    "--verify-rpc-certificate",
    "Verify the Sage RPC server certificate",
    false,
  )
  .option(
    "--derivation-page-size <count>",
    "Number of Sage derivations fetched per request",
    parsePositiveInteger,
    500,
  )
  .option(
    "--receiver-public-key <hex>",
    "Synthetic receiver public key; bypasses Sage derivation lookup",
  )
  .option(
    "--build-only",
    "Build the unsigned spends without contacting Sage RPC",
    false,
  )
  .option(
    "--submit",
    "Submit the signed bundle through Sage RPC (otherwise only sign it)",
    false,
  )
  .option(
    "-o, --output <path>",
    "Write the unsigned and signed transaction data to this JSON file",
    "recovery-transaction.json",
  )
  .parse();

const options = program.opts();
options.fee ??= 0n;

function decodeMainnetAddress(value, label) {
  let address;
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

function requireResponse(response, label, property) {
  if (!response.success || !response[property]) {
    throw new Error(`${label} failed: ${response.error ?? "no result returned"}`);
  }
  return response[property];
}

function coinSpendJson(coinSpend) {
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

async function parseClawbackFromRecord(client, record, expectedPuzzleHash) {
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
        memos[1],
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

async function discoverClawback(client, puzzleHash, records) {
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

async function discoverCoins(client, clawbackAddress, requestedCoinIds) {
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
  const requested = requestedCoinIds
    ? new Set(requestedCoinIds)
    : null;
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
    throw new Error(`Requested coins are missing or spent: ${missing.join(", ")}`);
  }
  if (BigInt(Math.floor(Date.now() / 1_000)) < clawback.seconds) {
    throw new Error(
      `Clawback receiver path is timelocked until ${clawback.seconds}`,
    );
  }

  return { clawback, records: unspent };
}

class SageRpc {
  constructor(rpcOptions) {
    this.baseUrl = new URL(rpcOptions.rpcUrl);
    this.certPath = resolve(rpcOptions.rpcCert);
    this.keyPath = resolve(rpcOptions.rpcKey);
    this.caPath = rpcOptions.rpcCa ? resolve(rpcOptions.rpcCa) : null;
    this.rejectUnauthorized = rpcOptions.verifyRpcCertificate;
    this.tls = null;
  }

  async loadTls() {
    if (!this.tls) {
      const [cert, key, ca] = await Promise.all([
        readFile(this.certPath),
        readFile(this.keyPath),
        this.caPath ? readFile(this.caPath) : null,
      ]);
      this.tls = { cert, key, ca };
    }
    return this.tls;
  }

  async call(endpoint, body) {
    const tls = await this.loadTls();
    const payload = JSON.stringify(body);
    const url = new URL(endpoint.replace(/^\//, ""), `${this.baseUrl}/`);

    return new Promise((resolvePromise, rejectPromise) => {
      const request = https.request(
        url,
        {
          method: "POST",
          cert: tls.cert,
          key: tls.key,
          ca: tls.ca ?? undefined,
          rejectUnauthorized: this.rejectUnauthorized,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          },
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            text += chunk;
          });
          response.on("end", () => {
            if (
              response.statusCode === undefined ||
              response.statusCode < 200 ||
              response.statusCode >= 300
            ) {
              rejectPromise(
                new Error(
                  `Sage RPC ${endpoint} failed (${response.statusCode ?? "unknown"}): ${text}`,
                ),
              );
              return;
            }
            try {
              resolvePromise(text ? JSON.parse(text) : {});
            } catch (error) {
              rejectPromise(
                new Error(`Sage RPC ${endpoint} returned invalid JSON: ${error}`),
              );
            }
          });
        },
      );
      request.on("error", rejectPromise);
      request.end(payload);
    });
  }
}

async function findReceiverPublicKey(rpc, receiverAddress, pageSize) {
  for (const hardened of [false, true]) {
    let offset = 0;
    while (true) {
      const response = await rpc.call("get_derivations", {
        hardened,
        offset,
        limit: pageSize,
      });
      const match = response.derivations.find(
        (derivation) => derivation.address === receiverAddress,
      );
      if (match) {
        return {
          publicKey: PublicKey.fromBytes(fromHex(match.public_key)),
          derivation: {
            hardened,
            index: match.index,
            address: match.address,
          },
        };
      }

      offset += response.derivations.length;
      if (offset >= response.total || response.derivations.length === 0) {
        break;
      }
    }
  }

  throw new Error(
    `The selected Sage wallet does not own clawback receiver ${receiverAddress}`,
  );
}

function parseReceiverPublicKey(value, receiverPuzzleHash) {
  const hex = value.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{96}$/.test(hex)) {
    throw new Error("--receiver-public-key must be a 48-byte public key");
  }
  const publicKey = PublicKey.fromBytes(fromHex(hex));
  const puzzleHash = standardPuzzleHash(publicKey);
  if (!bytesEqual(puzzleHash, receiverPuzzleHash)) {
    throw new Error(
      "--receiver-public-key does not match the clawback receiver puzzle hash",
    );
  }
  return publicKey;
}

function buildUnsignedCoinSpends(
  clawback,
  records,
  receiverPublicKey,
  destination,
  fee,
) {
  const total = records.reduce(
    (sum, record) => sum + record.coin.amount,
    0n,
  );
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

try {
  const clawbackAddress = decodeMainnetAddress(
    options.clawbackAddress,
    "Clawback address",
  );
  const coinset = options.coinsetUrl
    ? new RpcClient(options.coinsetUrl)
    : RpcClient.mainnet();
  const { clawback, records } = await discoverCoins(
    coinset,
    clawbackAddress,
    options.coinId,
  );
  if (!bytesEqual(clawback.puzzleHash(), clawbackAddress.puzzleHash)) {
    throw new Error("Discovered clawback does not match the supplied address");
  }

  const receiverAddress = new Address(
    clawback.receiverPuzzleHash,
    "xch",
  ).encode();
  const destination = decodeMainnetAddress(
    options.destination ?? receiverAddress,
    "Destination",
  );
  const rpc = new SageRpc(options);

  let receiverPublicKey;
  let derivation = null;
  if (options.receiverPublicKey) {
    receiverPublicKey = parseReceiverPublicKey(
      options.receiverPublicKey,
      clawback.receiverPuzzleHash,
    );
  } else {
    if (options.buildOnly) {
      throw new Error(
        "--build-only requires --receiver-public-key because Sage RPC is disabled",
      );
    }
    const receiver = await findReceiverPublicKey(
      rpc,
      receiverAddress,
      options.derivationPageSize,
    );
    receiverPublicKey = receiver.publicKey;
    derivation = receiver.derivation;
  }

  const unsigned = buildUnsignedCoinSpends(
    clawback,
    records,
    receiverPublicKey,
    destination,
    options.fee,
  );
  const result = {
    clawbackAddress: clawbackAddress.encode(),
    receiverAddress,
    receiverDerivation: derivation,
    destination: destination.encode(),
    coinIds: records.map((record) => `0x${toHex(record.coin.coinId())}`),
    inputAmountMojos: unsigned.inputAmount.toString(),
    feeMojos: options.fee.toString(),
    outputAmountMojos: unsigned.outputAmount.toString(),
    coinSpends: unsigned.coinSpends,
    preview: null,
    spendBundle: null,
    submitted: false,
  };

  if (!options.buildOnly) {
    result.preview = await rpc.call("view_coin_spends", {
      coin_spends: unsigned.coinSpends,
    });
    const signed = await rpc.call("sign_coin_spends", {
      coin_spends: unsigned.coinSpends,
      auto_submit: false,
      partial: false,
    });
    result.spendBundle = signed.spend_bundle;

    if (options.submit) {
      await rpc.call("submit_transaction", {
        spend_bundle: signed.spend_bundle,
      });
      result.submitted = true;
    }
  }

  const outputPath = resolve(options.output);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(
    JSON.stringify(
      {
        output: outputPath,
        clawbackAddress: result.clawbackAddress,
        receiverAddress: result.receiverAddress,
        destination: result.destination,
        coins: result.coinIds,
        inputAmountMojos: result.inputAmountMojos,
        feeMojos: result.feeMojos,
        outputAmountMojos: result.outputAmountMojos,
        signed: result.spendBundle !== null,
        submitted: result.submitted,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
