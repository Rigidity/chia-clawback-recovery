# Chia Clawback Recovery

A command-line tool for recovering XCH sent to a Chia Clawback V2 wrapper
address.

The recovery tool discovers the wrapper from its on-chain history, constructs
receiver-path spends with `chia-wallet-sdk`, and asks a running Sage wallet to
preview, sign, and optionally submit the transaction through its RPC API.

## Requirements

- Node.js 22.12 or newer
- A synced Sage wallet with RPC enabled
- The selected Sage wallet must own the clawback's receiver custody key

Install dependencies:

```sh
npm install
```

## Recover coins from a clawback address

Build, preview, and sign receiver-path spends without broadcasting:

```sh
npm run recover -- \
  --clawback-address xch1CLAWBACK_WRAPPER_ADDRESS \
  --destination xch1DESTINATION_ADDRESS \
  --fee 1000000000
```

Review `recovery-transaction.json`, then add `--submit` to broadcast:

```sh
npm run recover -- \
  --clawback-address xch1CLAWBACK_WRAPPER_ADDRESS \
  --destination xch1DESTINATION_ADDRESS \
  --fee 1000000000 \
  --submit
```

If `--destination` is omitted, the tool sends the recovered amount to the
clawback's receiver custody address. If `--coin-id` is omitted, it spends every
unspent coin at the wrapper address.

Run `npm run recover -- --help` for RPC host, certificate, key, coin selection,
and offline build options.

## Safety

- Broadcasting is disabled unless `--submit` is supplied.
- Always inspect the generated transaction before submitting it.
- Test with a wallet and amount you control before using this for recovery.
- The RPC client certificate and key authenticate to Sage; they are not the
  wallet's blockchain private key.
- Never share wallet mnemonics or private keys.

## How recovery works

A Clawback V2 puzzle includes sender, receiver, and permissionless push-through
paths. This tool reconstructs the wrapper from a historical creation memo, finds
its unspent coins through Coinset, and spends them through the receiver path.
Sage RPC supplies the receiver public key, previews the unsigned spends, signs
them with the selected wallet, and submits only when requested.

This also handles coins whose amount differs from the amount embedded in the
historical wrapper. That can happen when another clawback is pushed through to
an address that is itself a clawback puzzle.
