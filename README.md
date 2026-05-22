# ocarina.trade

Peer-to-peer OTC trades for NFTs and tokens. No backend, no accounts, no middleman.

**Live site:** [ocarina.trade](https://ocarina.trade)

## What it does

- **Create an offer** — Select the assets you want to trade (exact ERC-721/ERC-1155 tokens, collection-wide Any Token NFT criteria, whitelisted ERC-20, or ETH on the taker side), optionally restrict to a specific taker, sign the order, and publish it on-chain. A shareable link is generated.
- **View an offer** — Anyone with the link can see both sides of the trade, verify the assets on Etherscan, and check the order status (open, filled, cancelled, expired).
- **Accept an offer** — The eligible taker approves their assets, resolves any Any Token items to concrete token IDs, and executes the atomic trade in a single transaction. Both sides exchange assets simultaneously — no escrow, no partial fills.
- **Preflight checks** — Before publication, the app rechecks maker holdings and Seaport approvals for exact offered assets. Before acceptance, it simulates the exact Seaport fill after taker approvals and before the final transaction.

## How it works

Asset transfer and settlement are handled by [Seaport](https://github.com/ProjectOpenSea/seaport) (v1.6), OpenSea's audited, immutable, on-chain settlement protocol. Orders are signed off-chain (free, no gas), registered through OTCRegistry for publication and settlement eligibility, and settled atomically on-chain when accepted.

The only custom contract is **OTCRegistry**, which:
- Restricts who can fill an order (optional taker address)
- Enforces an ERC-20 whitelist (prevents impostor token scams)
- Requires explicit fulfiller signatures for any appended cash tips
- Publishes signed orders through events for the offers page
- Requires prior registration before an OTCRegistry-zoned order can settle

OTCRegistry never touches user funds. Assets stay in your wallet until the trade executes.

## Any Token offers

For NFT contracts, an offer or consideration item can target **Any Token** from that contract instead of one exact token ID. This is implemented with Seaport criteria items using wildcard criteria (`identifierOrCriteria = 0`).

- ERC-721 quantity is represented by adding multiple Any Token items for the same contract. The fulfiller chooses one concrete token ID for each item at fill time.
- ERC-1155 Any Token items can include an amount, and the fulfiller chooses the token ID at fill time.
- Merged collections that span multiple contracts do not show the Add Any Token button in the picker, because the target contract would be ambiguous. Use manual entry to choose a specific contract.

## Contracts

| Network | Address |
|---|---|
| Ethereum | [`0x07C0000007b4B558e2fCd47F47A573413B0Caf7C`](https://etherscan.io/address/0x07C0000007b4B558e2fCd47F47A573413B0Caf7C) |
| Base | [`0x07C00000057b66A84004adD3B0f9164E744354CB`](https://basescan.org/address/0x07C00000057b66A84004adD3B0f9164E744354CB) |
| Polygon | [`0x07C000000e10b73C0506f36BA75E50a5D3147061`](https://polygonscan.com/address/0x07C000000e10b73C0506f36BA75E50a5D3147061) |
| Ink (unlisted) | [`0x07C00000025CF03243E6fde1BE86af60D12fbF8f`](https://explorer.inkonchain.com/address/0x07C00000025CF03243E6fde1BE86af60D12fbF8f) |

Ink is not shown in the ocarina.trade UI, but the OTCRegistry deployment is available for other frontends to use.

## Trust model

- **No backend** — all state is on-chain or in the URL. Nothing to maintain, no servers to trust.
- **No database** — order publication and discovery are powered by on-chain events.
- **No escrow** — assets remain in your wallet until the atomic trade.
- **Preflight safety** — the frontend warns on suspicious NFT signals and checks holdings, approvals, and fillability before users submit the irreversible transaction.
- **Audited settlement** — Seaport has been professionally audited and has processed billions in volume.
- **Open source** — fork it, verify it, run your own.

## Tech stack

- **Chains**: Ethereum, Base, Polygon
- **Settlement**: Seaport 1.6 (immutable, canonical address across all chains)
- **Custom contract**: OTCRegistry zone/registry (Solidity 0.8.28, Foundry)
- **Frontend**: React, ethers.js, Vite — static site, no server required
- **Wallet**: Reown AppKit (MetaMask, WalletConnect, Coinbase Wallet, etc.)
- **Identity**: ENS forward and reverse resolution

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

GPL-3.0-only. See [LICENSE](LICENSE).
