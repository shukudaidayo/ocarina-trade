# OTC Swap

Peer-to-peer OTC swaps for NFTs and tokens. No backend, no accounts, no middleman.

**Live site:** [shukudaidayo.github.io/otc-swap](https://shukudaidayo.github.io/otc-swap/)

## What it does

- **Create an offer** — Select the assets you want to trade (ERC-721, ERC-1155, whitelisted ERC-20, or ETH), optionally restrict to a specific taker, and sign the order. A shareable link is generated.
- **View an offer** — Anyone with the link can see both sides of the swap, verify the assets on Etherscan, and check the order status (open, filled, cancelled, expired).
- **Accept an offer** — The eligible taker approves their assets and executes the atomic swap in a single transaction. Both sides exchange assets simultaneously — no escrow, no partial fills.

## How it works

All swap logic is handled by [Seaport](https://github.com/ProjectOpenSea/seaport) (v1.6), OpenSea's audited, immutable, on-chain settlement protocol. Orders are signed off-chain (free, no gas) and settled atomically on-chain when accepted.

The only custom contract is **OTCZone** (~110 lines), which:
- Restricts who can fill an order (optional taker address)
- Enforces an ERC-20 whitelist (prevents impostor token scams)
- Emits events for order discovery (the offers page)

OTCZone never touches user funds. Assets stay in your wallet until the swap executes.

## Trust model

- **No backend** — all state is on-chain or in the URL. Nothing to maintain, no servers to trust.
- **No database** — order discovery is powered by on-chain events.
- **No escrow** — assets remain in your wallet until the atomic swap.
- **Audited settlement** — Seaport has been professionally audited and has processed billions in volume.
- **Open source** — fork it, verify it, run your own.

## Tech stack

- **Settlement**: Seaport 1.6 (immutable, canonical address across all chains)
- **Custom contract**: OTCZone (Solidity 0.8.28, Foundry)
- **Frontend**: React, ethers.js, Vite — static site, no server required
- **Wallet**: Reown AppKit (MetaMask, WalletConnect, Coinbase Wallet, etc.)

## Development

```bash
npm install
npm run dev        # Start dev server
npm run build      # Production build

# Contracts (from contracts/)
forge build        # Compile
forge test         # Run tests
```

## License

TBD
