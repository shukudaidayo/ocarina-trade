# OTC Swap - Technical Specification

## 1. Overview

A peer-to-peer OTC swap website for trading NFTs (and eventually WETH/USDC) directly between two parties without intermediaries. Users create swap offers, share a link, and the counterparty accepts on-chain. No backend, no database, no accounts.

### Motivation

Both otc.sudoswap.xyz and opensea.io/deals are dead. The ecosystem needs a simple, durable OTC swap tool. This project prioritizes **longevity** and **minimal maintenance** over feature richness.

### Design Principles

- **No backend**: All state lives on-chain or in the URL. Nothing to maintain, no servers to keep running.
- **Minimal dependencies**: Fewer deps = fewer things that break over time.
- **Simple smart contract**: Custom swap contract rather than depending on a third-party protocol (0x v2, which sudoswap used, is effectively abandoned).
- **Anti-scam by default**: Token verification and warnings are first-class concerns, not afterthoughts.

---

## 2. V1 Scope

- **Chain**: Ethereum Mainnet only
- **Token types**: ERC-721 and ERC-1155 only
- **Swap structure**: Multi-asset <-> multi-asset (each side can have 1+ NFTs)
- **Counterparty**: Optionally restricted to a specific address, or open to anyone
- **Expiration**: Optional expiry timestamp
- **Cross-chain**: Out of scope

---

## 3. Architecture

### 3.1 Smart Contract

A single, purpose-built swap contract deployed on Ethereum. No upgradability proxy (simplicity over flexibility).

#### Data Structures

```solidity
struct Asset {
    address token;       // Contract address
    uint256 tokenId;     // Token ID
    uint256 amount;      // 1 for ERC-721, variable for ERC-1155
    AssetType assetType; // ERC721 or ERC1155 (later: ERC20 for WETH/USDC only)
}

enum AssetType { ERC721, ERC1155 }

// Note: The full order is NOT stored on-chain. Only a hash is stored
// to track status. The order details live in the URL/off-chain.
enum OrderStatus { NONE, OPEN, FILLED, CANCELLED }  // NONE = default (order doesn't exist)
```

#### Core Functions

```solidity
// Create a swap offer. Emits an event with the order hash.
// Maker's assets must be approved to this contract before calling.
// orderHash = keccak256(abi.encode(maker, taker, makerAssets, takerAssets, expiration, salt))
function createOrder(
    address taker,          // address(0) = open to anyone
    Asset[] makerAssets,    // What the maker is offering
    Asset[] takerAssets,    // What the maker wants in return
    uint256 expiration,     // 0 = no expiry
    uint256 salt            // Nonce for uniqueness (frontend uses Date.now())
) external returns (bytes32 orderHash);

// Accept a swap. Caller must be the taker (or anyone if taker == address(0)).
// Taker's assets must be approved to this contract.
// Atomically transfers all assets in both directions.
function fillOrder(
    address maker,
    address taker,
    Asset[] makerAssets,
    Asset[] takerAssets,
    uint256 expiration,
    uint256 salt
) external;

// Cancel an open order. Only callable by the maker.
function cancelOrder(bytes32 orderHash) external;

// Emergency kill switch. Only callable by contract owner.
// After calling: createOrder and fillOrder revert, cancelOrder still works.
// One-way: there is no unkill. If the bug is a false alarm, redeploy.
function kill() external;

// Query kill status.
function killed() external view returns (bool);
```

#### Key Design Decisions

- **No escrow**: Assets are NOT held by the contract. They stay in the maker's wallet until the swap executes. The contract uses `transferFrom` at fill time. This means the maker can still use/transfer their assets while the offer is open (but the fill will fail if they no longer hold them).
- **No signatures**: Unlike sudoswap/0x, we use an on-chain `createOrder` transaction instead of off-chain signatures. This is slightly more expensive for the maker (one extra tx) but dramatically simpler - no EIP-712, no signature validation, no replay protection complexity. The contract just stores a mapping of `orderHash => OrderStatus`.
- **No fees**: V1 has no protocol fees. This can be added later if needed.
- **Kill switch instead of upgradability**: The contract is immutable - no upgrade proxy. Instead, an owner-only `kill()` function permanently disables order creation and filling. Cancellation remains functional so makers can revoke approvals. If a bug is found: kill the contract, deploy a fixed version, update the frontend. The owner's maximum power is pausing the contract; they cannot change logic or access funds. Migration is clean because no assets are escrowed.
- **Migration strategy**: The URL includes the contract address, so old swap links always talk to the correct contract (for status checks and cancellation). The frontend's "Create Swap" page points to the latest contract. After a kill-and-redeploy, old links still work for viewing/cancelling, and new swaps go to the new contract.

#### Events

```solidity
event OrderCreated(
    bytes32 indexed orderHash,
    address indexed maker,
    address indexed taker,
    Asset[] makerAssets,
    Asset[] takerAssets,
    uint256 expiration,
    uint256 salt
);
event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker);
event OrderCancelled(bytes32 indexed orderHash, address indexed maker);
```

#### Security Considerations

- Reentrancy guard on `fillOrder` (uses transfers to potentially malicious contracts)
- Check that all assets actually transfer successfully (revert on failure)
- Validate that msg.sender matches taker requirement
- Validate expiration hasn't passed
- Validate order is in OPEN status

### 3.2 Frontend

#### Tech Stack

- **Framework**: React
- **Web3**: ethers.js v6 (lighter and more maintained than web3.js)
- **Wallet connection**: EIP-6963 (wallet discovery standard) + direct injected provider fallback. No third-party wallet SDK (Blocknative, Web3Modal, etc.) - these are heavy dependencies that break over time.
- **Styling**: Minimal custom CSS. No CSS framework.
- **NFT metadata**: On-chain tokenURI + IPFS/HTTP resolution. No dependency on OpenSea or other centralized APIs.
- **Build**: Vite (minimal config, fast, stable)
- **Hosting**: Static site (GitHub Pages, Cloudflare Pages, or IPFS)

#### Framework Decision: React

Rationale: Vanilla JS gets unwieldy for reactive UIs with wallet state, dynamic asset lists, and async data loading. React is the most widely used frontend framework, has the largest ecosystem of examples and answers, and will be maintained indefinitely. Vite handles JSX natively with the React plugin.

#### Pages / Routes

Hash-based routing (works on static hosts, no server config needed).

1. **`#/`** - Home / landing page
   - Brief explanation of what the site does
   - "Create Swap" button
   - "Connect Wallet" in header

2. **`#/create`** - Create a new swap offer
   - Two columns: "You Send" and "You Receive"
   - Each column: add/remove assets (token address + token ID)
   - Optional: taker address field
   - Optional: expiration date picker
   - Asset preview (fetch and display NFT metadata)
   - Approval flow for maker's assets
   - Submit: calls `createOrder`, then generates shareable link

3. **`#/swap/:chainId/:contractAddress/:encodedOrder`** - View and accept a swap
   - Decode order details from URL
   - Display both sides of the trade with NFT previews
   - Show order status (open/filled/cancelled/expired)
   - Show verification warnings (see anti-scam section)
   - If open and user is eligible taker: approval flow + "Accept Swap" button
   - If user is maker: "Cancel" button

4. **`#/offers`** - Browse all offers
   - Toggle between "Open" and "Completed" views
   - Populated by querying `OrderCreated`, `OrderFilled`, and `OrderCancelled` events via RPC
   - Open offers: all `OrderCreated` events minus those with a corresponding `OrderFilled` or `OrderCancelled`
   - Completed offers: all `OrderFilled` events
   - Cancelled offers are excluded from both views
   - Each offer links to its full swap page (`#/swap/{chainId}/{contract}/{data}`), where the maker can cancel or the taker can accept
   - **Event querying strategy**: Direct RPC `eth_getLogs` queries. For a low-volume contract this is sufficient. If block range limits become a problem, fall back to Etherscan's event log API.

#### URL Encoding

Order data is encoded in the URL so no backend is needed:

```
#/swap/{chainId}/{contractAddress}/{base64url(JSON.stringify(orderParams))}
```

Chain ID and contract address are path segments (not in the JSON blob) for readability and forward-compatibility with multi-chain support. The JSON payload contains the parameters needed to call `fillOrder`:
```json
{
  "maker": "0x...",
  "taker": "0x0000000000000000000000000000000000000000",
  "makerAssets": [{"token": "0x...", "tokenId": "123", "amount": "1", "assetType": 0}],
  "takerAssets": [{"token": "0x...", "tokenId": "456", "amount": "1", "assetType": 0}],
  "expiration": 0,
  "salt": 1709568000
}
```

We use base64url rather than LZ-string compression (as sudoswap did) because:
- One fewer dependency
- URLs are slightly longer but still manageable for typical swaps
- Easier to debug
- If URL length becomes a problem, we can add compression later

---

## 4. Anti-Scam Measures

This is a critical differentiator. The most common OTC scam is **impostor tokens**: a scammer creates a contract that mimics a valuable collection (same name, same images) but is worthless.

### 4.1 Token Verification System

#### Verified Token Lists

Maintain a curated JSON file of known, legitimate token contract addresses, bundled with the frontend:

```json
{
  "1": {
    "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D": {
      "name": "Bored Ape Yacht Club",
      "symbol": "BAYC",
      "type": "ERC721",
      "verified": true
    }
  }
}
```

Source this from existing curated lists (e.g., Ethereum Lists, token lists from major aggregators). The list is loaded in two layers:
1. **Bundled fallback**: A static copy shipped with the build, so the site works even if the remote fetch fails.
2. **Remote primary**: Fetched from a GitHub raw URL on page load. This allows updating the list (adding new verified collections, flagging scam contracts) without redeploying the site.

#### UI Verification Indicators

For each asset in a swap:

- **Verified** (green checkmark): Contract address is on the verified token list.
- **Unverified** (yellow warning): Contract address is NOT on any known list. Display a prominent warning: *"This token contract is not recognized. Verify the contract address on Etherscan before accepting."*
- **Suspicious** (red alert): Contract has the same name/symbol as a verified token but a different address. Display: *"WARNING: This token claims to be [X] but has a different contract address than the verified [X] collection. This is likely a scam."*

#### Always-Visible Contract Addresses

- Always display the full contract address for every asset, linked to Etherscan
- Never hide or abbreviate contract addresses in the swap view
- Show the contract's deployment date (via Etherscan link) - very new contracts mimicking established collections are a red flag

#### Metadata Warnings

- If tokenURI returns metadata from a suspicious domain (not IPFS/Arweave), show a note
- If metadata/images fail to load, show a clear placeholder rather than silently failing

### 4.2 User Education

- Brief, non-dismissable info box on the swap acceptance page: *"Always verify contract addresses before accepting a swap. Scammers create fake tokens that look identical to valuable ones."*
- Link to Etherscan for each contract address

### 4.3 Future Enhancements (Post-V1)

- Integration with Reservoir or similar API for richer collection verification
- On-chain collection verification (check if contract is verified on Etherscan)
- Community-reported scam contracts blocklist

---

## 5. NFT Metadata Resolution

Fetching NFT metadata without depending on centralized APIs (OpenSea is unreliable/paywalled):

### Resolution Chain

1. Call `tokenURI(tokenId)` (ERC-721) or `uri(tokenId)` (ERC-1155) on the contract
2. If the URI is an IPFS hash (`ipfs://...`), resolve via a public IPFS gateway (configurable, default: `https://ipfs.io/ipfs/`)
3. If the URI is an HTTP(S) URL, fetch directly
4. If the URI is a `data:` URI (on-chain metadata), decode directly
5. Parse the returned JSON for `name`, `image`, `description`
6. Resolve the `image` field using the same IPFS/HTTP/data logic
7. If any step fails, show a placeholder image and the raw token ID

### Caching

- Cache metadata in `sessionStorage` keyed by `chainId:contractAddress:tokenId`
- No persistent cache (metadata can change, and we want simplicity)

### Future: Third-Party Metadata Provider

If on-chain resolution proves too slow or unreliable in practice (e.g. flaky IPFS gateways), we could add a provider like Alchemy as a faster primary source with on-chain as fallback. Only worth doing if there's a demonstrated problem — adding an API dependency is a maintenance/longevity cost.

---

## 6. Wallet Connection

### EIP-6963 (Modern Wallet Discovery)

Use the EIP-6963 standard to discover installed wallets without depending on a wallet SDK:

1. Dispatch `eip6963:requestProvider` event
2. Listen for `eip6963:announceProvider` events
3. Display discovered wallets in a connection modal
4. Fallback: check `window.ethereum` for injected providers

This approach has zero dependencies and works with all modern wallets (MetaMask, Rabby, Coinbase Wallet, etc.).

### Connection State

- Store last-connected wallet preference in `localStorage`
- Auto-reconnect on page load if previously connected
- Display connected address in header (truncated with ENS resolution if available)
- ENS names also shown for maker/taker addresses on the swap and offers pages (via `provider.lookupAddress`)

---

## 7. User Flow

### Creating a Swap

1. User connects wallet
2. Navigates to Create page
3. Adds assets they want to send:
   - Enters contract address
   - Enters token ID
   - UI fetches and displays NFT preview (image, name, collection)
   - UI shows verification status (verified/unverified/suspicious)
4. Adds assets they want to receive (same flow)
5. Optionally sets taker address and expiration
6. Clicks "Create Swap"
7. UI checks and requests approvals for all maker assets (setApprovalForAll to swap contract)
8. UI sends `createOrder` transaction
9. After confirmation, UI generates shareable link
10. User copies link and sends to counterparty (via DM, social media, etc.)

### Accepting a Swap

1. Counterparty opens the shared link
2. UI decodes order from URL
3. UI queries contract for order status
4. UI fetches and displays all assets with verification indicators
5. Counterparty reviews the trade
6. Connects wallet
7. UI checks and requests approvals for taker assets
8. Clicks "Accept Swap"
9. UI sends `fillOrder` transaction
10. Assets are atomically swapped

### Cancelling a Swap

1. Maker opens the swap link (or navigates from their history)
2. Clicks "Cancel"
3. UI sends `cancelOrder` transaction
4. Order is marked as cancelled on-chain

---

## 8. Future Roadmap

### V1.1 - WETH/USDC Support
- Add `ERC20` to `AssetType` enum
- **Whitelist only**: The contract hardcodes the allowed ERC-20 addresses (WETH and USDC per chain). `createOrder` and `fillOrder` revert if an ERC-20 asset references any other address. This eliminates impostor ERC-20 tokens entirely.
- UI shows token symbol, amount, and decimals-adjusted display value
- No token list dependency — just two hardcoded addresses per chain

### V1.2 - Additional EVM Chains
- Deploy the same contract on Polygon, Arbitrum, Base, Optimism, etc.
- Add chain selector to the UI
- Chain ID is already encoded in the swap URL; add chain-aware routing in the frontend
- Maintain per-chain verified token lists
- Use chain-specific RPC endpoints (public RPCs or configurable)

### V2 - Solana Support
- Separate Solana swap program (Rust/Anchor)
- Solana wallet adapter integration
- Shared UI with chain-type detection from URL

### Future - Cross-Chain Swaps
- Fundamentally different mechanism from same-chain swaps (requires escrow, relay, or HTLC)
- Would use separate URL namespace (e.g. `#/xswap/...`) and independent logic
- No conflict with the same-chain architecture described in this spec

### Not Planned
- Order book / listing marketplace (different product)
- Chat / messaging (use existing platforms)
- Mobile app (responsive web is sufficient)

---

## 9. Forkability & Continuity

This project is designed so that if the original maintainer disappears, anyone can fork and run it with minimal effort.

### License

MIT. No restrictions on forking, modifying, or redeploying.

### Permissionless Contract

The deployed smart contract is permissionless — anyone can build a frontend that talks to it. If the original site goes down, someone just deploys a new static site pointing to the same contract address. No migration, no coordination, no permission needed.

### Frontend Configurability

All environment-specific values live in a single config file (`src/lib/constants.js`):
- Contract address(es) per chain
- RPC endpoint URLs
- Verified token list remote URL
- IPFS gateway URL

A fork only needs to update this one file to point to their own infrastructure.

### No Proprietary Services

The site requires zero accounts, API keys, or proprietary services to run:
- NFT metadata: on-chain tokenURI + public IPFS gateways
- Blockchain data: public RPC endpoints (or user's own wallet provider)
- Hosting: any static file host
- Verified token list: a static JSON file (bundled + optional remote fetch)

### Kill Switch Continuity

The kill switch requires the owner's private key. If the owner loses access, the kill switch simply can't be used — the contract continues operating normally. This is acceptable: the kill switch is a safety net, not a dependency. The contract's correct operation does not depend on the owner being available.

### Verified Token List

The remote token list URL will point to a GitHub raw URL. If the original repo is abandoned:
- The bundled fallback list still works (just won't get new additions)
- A fork updates the remote URL in `constants.js` to point to their own repo
- The list format is simple JSON — easy for anyone to maintain

---

## 10. Deployment & Hosting

### Static Hosting

The site is a static SPA. Candidate hosts (in order of preference):

1. **Cloudflare Pages**: Free, fast, reliable, custom domain support
2. **GitHub Pages**: Free, simple, tied to repo
3. **IPFS + ENS**: Most censorship-resistant, but slower and harder to update

### Domain

TBD. Something short and memorable. Ideally a `.xyz` or `.trade` domain.

### CI/CD

- GitHub Actions: build on push to `main`, deploy to hosting provider
- No staging environment needed for V1

---

## 11. File Structure (Proposed)

```
/
├── index.html
├── vite.config.js
├── package.json
├── src/
│   ├── main.jsx              # Entry point, router setup
│   ├── app.jsx               # App shell (header, router outlet, footer)
│   ├── style.css             # Global styles
│   ├── pages/
│   │   ├── home.jsx
│   │   ├── create.jsx
│   │   ├── swap.jsx
│   │   └── offers.jsx
│   ├── components/
│   │   ├── asset-card.jsx    # NFT display card with verification badge
│   │   ├── asset-input.jsx   # Contract address + token ID input
│   │   ├── wallet-button.jsx # Connect/disconnect wallet
│   │   └── warning-banner.jsx
│   ├── lib/
│   │   ├── contract.js       # Contract interaction (ethers.js)
│   │   ├── wallet.js         # EIP-6963 wallet connection
│   │   ├── metadata.js       # NFT metadata resolution
│   │   ├── encoding.js       # URL encoding/decoding
│   │   └── constants.js      # Addresses, ABIs, chain config
│   └── data/
│       └── verified-tokens.json  # Curated verified token list
├── contracts/
│   ├── OTCSwap.sol           # Main swap contract
│   └── test/
│       └── OTCSwap.t.sol     # Foundry tests
└── public/
    └── favicon.ico
```

---

## 12. Dependencies (Exhaustive List)

### Runtime
- **ethers** (v6): Contract interaction, ABI encoding, wallet provider
- **react** + **react-dom** (v19): UI rendering
- **react-router** (v7): Hash-based routing

### Dev
- **vite**: Build tool
- **@vitejs/plugin-react**: JSX transform
- **foundry** (forge/cast): Smart contract development and testing

That's it. Three runtime dependencies.

---

## 13. Resolved Decisions

1. **Transaction-based order creation** (decided). Simpler contract, no EIP-712 complexity, gas cost is negligible at current prices.

2. **Verified token list is updatable without redeployment** (decided). Fetch from a GitHub raw URL as the primary source, with the bundled list as fallback. This keeps the list fresh without requiring a site redeploy for every new collection.

3. **ENS resolution included in V1** (decided). Display ENS names for maker/taker addresses where available. ethers.js supports this natively, so implementation cost is near zero. Adds trust and readability.

## 14. Open Questions

None currently. All major decisions have been resolved.
