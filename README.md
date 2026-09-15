# Chia Clawback Recovery

A command-line tool for recovering XCH sent to a Chia Clawback V2 wrapper
address.

The recovery tool discovers the wrapper from its on-chain history, constructs
receiver-path spends with `chia-wallet-sdk`, and asks a running Sage wallet to
preview, sign, and submit the transaction through its RPC API.

## Requirements

- Node.js 22.12 or newer
- A synced Sage wallet with RPC enabled
- The selected Sage wallet must own the clawback's receiver custody key

Install dependencies:

```sh
npm install
```

## Recover coins from a clawback address

Build and submit receiver-path spends:

```sh
npm run recover -- \
  --clawback-address xch1CLAWBACK_WRAPPER_ADDRESS \
  --destination xch1DESTINATION_ADDRESS \
  --fee 1000000000
```

If `--destination` is omitted, the tool sends the recovered amount to the
clawback's receiver custody address. If `--coin-id` is omitted, it spends every
unspent coin at the wrapper address.

Run `npm run recover -- --help` for RPC host, certificate, key, and coin
selection options.

By default, the RPC certificate and key are read from Sage's standard
application data directory for macOS, Windows, or Linux. Use `--rpc-cert` and
`--rpc-key` if Sage stores them elsewhere.

## Safety

- Running the recovery command signs and submits the transaction immediately.
- Verify the clawback address, destination, selected coin IDs, and fee first.
- Test with a wallet and amount you control before using this for recovery.
- The RPC client certificate and key authenticate to Sage; they are not the
  wallet's blockchain private key.
- Never share wallet mnemonics or private keys.

## How recovery works

A Clawback V2 puzzle includes sender, receiver, and permissionless push-through
paths. This tool reconstructs the wrapper from a historical creation memo, finds
its unspent coins through Coinset, and spends them through the receiver path.
Sage RPC supplies the receiver public key, previews the unsigned spends, signs
them with the selected wallet, and submits the resulting spend bundle.

This also handles coins whose amount differs from the amount embedded in the
historical wrapper. That can happen when another clawback is pushed through to
an address that is itself a clawback puzzle.
