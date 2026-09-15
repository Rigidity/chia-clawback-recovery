import { Command, InvalidArgumentError } from "commander";

export interface RecoveryOptions {
  clawbackAddress: string;
  destination?: string;
  fee: bigint;
  coinId?: string[];
}

function parseNonNegativeBigInt(value: string): bigint {
  let parsed: bigint;
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

function normalizeCoinId(value: string): string {
  const hex = value.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new InvalidArgumentError(`invalid coin ID: ${value}`);
  }
  return hex;
}

export function parseCli(argv: string[]): RecoveryOptions {
  const program = new Command()
    .name("recover-nested-clawback")
    .description(
      "Recover unspent XCH from a Clawback V2 address and submit the transaction through Sage RPC.",
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
      (value: string, previous: string[] = []) => [
        ...previous,
        normalizeCoinId(value),
      ],
    )
    .parse(argv);

  const options = program.opts<RecoveryOptions>();
  options.fee ??= 0n;
  return options;
}
