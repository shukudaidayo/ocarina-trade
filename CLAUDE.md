# OTC Swap

Peer-to-peer NFT OTC swap site. No backend, no database — all state is on-chain or in the URL.

## Project Structure

- `SPEC-SEAPORT.md` — Full technical specification (source of truth for all design decisions)
- `contracts/` — Solidity smart contracts (Foundry)
- `src/` — Frontend (React + Vite)
- `refs/` — Reference codebases (sudoswap otc-ui-public, swap.kiwi) — gitignored, for study only

## Tech Stack

- **Smart contracts**: Solidity 0.8.28, Foundry (forge/cast), Seaport 1.6
- **Frontend**: React 19, ethers.js v6, Vite
- **Wallet**: Reown AppKit (@reown/appkit + @reown/appkit-adapter-ethers)
- **Styling**: Minimal custom CSS, no framework
- **NFT metadata**: On-chain tokenURI + IPFS resolution (no OpenSea/Alchemy)

## Key Design Principles

- Minimize dependencies (runtime deps: ethers, react, react-router, @reown/appkit)
- No backend, no API keys, no proprietary services
- Anti-scam token verification is a first-class concern
- Seaport handles all asset transfers — OTCZone never touches user funds
- Everything should be forkable and maintainable by someone else
- License: GPL-3.0-only (derivatives must stay open source)

## Commands

- `forge build` — Compile contracts (run from `contracts/`)
- `forge test` — Run contract tests (run from `contracts/`)
- `npm run dev` — Start frontend dev server
- `npm run build` — Build frontend for production
