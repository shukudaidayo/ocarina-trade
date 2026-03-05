# OTC Swap

Peer-to-peer NFT OTC swap site. No backend, no database — all state is on-chain or in the URL.

## Project Structure

- `SPEC.md` — Full technical specification (source of truth for all design decisions)
- `contracts/` — Solidity smart contracts (Foundry)
- `src/` — Frontend (React + Vite)
- `refs/` — Reference codebases (sudoswap otc-ui-public, swap.kiwi) — gitignored, for study only

## Tech Stack

- **Smart contracts**: Solidity, Foundry (forge/cast)
- **Frontend**: React 19, ethers.js v6, Vite
- **Wallet**: EIP-6963 (no third-party wallet SDK)
- **Styling**: Minimal custom CSS, no framework
- **NFT metadata**: On-chain tokenURI + IPFS resolution (no OpenSea/Alchemy)

## Key Design Principles

- Minimize dependencies (3 runtime deps: ethers, react, react-router)
- No backend, no API keys, no proprietary services
- Anti-scam token verification is a first-class concern
- Contract is non-upgradeable with a one-way kill switch
- Everything should be forkable and maintainable by someone else

## Commands

- `forge build` — Compile contracts
- `forge test` — Run contract tests
- `npm run dev` — Start frontend dev server
- `npm run build` — Build frontend for production
