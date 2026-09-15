import { Address, RpcClient, bytesEqual, toHex } from "chia-wallet-sdk";

import {
  buildUnsignedCoinSpends,
  decodeMainnetAddress,
  discoverCoins,
} from "./clawback.ts";
import { parseCli } from "./cli.ts";
import { SageRpc, findReceiverPublicKey } from "./sage-rpc.ts";

async function main(): Promise<void> {
  const options = parseCli(process.argv);
  const clawbackAddress = decodeMainnetAddress(
    options.clawbackAddress,
    "Clawback address",
  );
  const coinset = RpcClient.mainnet();
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
  const rpc = new SageRpc();
  const receiver = await findReceiverPublicKey(rpc, receiverAddress);
  const unsigned = buildUnsignedCoinSpends(
    clawback,
    records,
    receiver.publicKey,
    destination,
    options.fee,
  );

  await rpc.call("sign_coin_spends", {
    coin_spends: unsigned.coinSpends,
    auto_submit: true,
    partial: false,
  });

  console.log(
    JSON.stringify(
      {
        clawbackAddress: clawbackAddress.encode(),
        receiverAddress,
        receiverDerivation: receiver.derivation,
        destination: destination.encode(),
        coins: records.map((record) => `0x${toHex(record.coin.coinId())}`),
        inputAmountMojos: unsigned.inputAmount.toString(),
        feeMojos: options.fee.toString(),
        outputAmountMojos: unsigned.outputAmount.toString(),
        submitted: true,
      },
      null,
      2,
    ),
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
