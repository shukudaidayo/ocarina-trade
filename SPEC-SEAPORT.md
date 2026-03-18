# OTC Swap - Technical Specification (Seaport Edition)

## 1. Overview

A peer-to-peer OTC swap website for trading NFTs (and whitelisted ERC-20s) directly between two parties. Uses OpenSea's **Seaport protocol** as the on-chain settlement layer, with a minimal custom **OTCZone** contract for taker restriction, ERC-20 whitelisting, and order discovery. No backend, no database, no accounts.

### Motivation

Both otc.sudoswap.xyz and opensea.io/deals are dead. The ecosystem needs a simple, durable OTC swap tool. This project prioritizes **longevity** and **minimal maintenance** over feature richness.

### Why Seaport

- **Near-zero custom contract surface.** The only custom contract (OTCZone, ~150 lines) handles taker restriction, ERC-20 whitelisting, signature-verified order discovery — it never touches user funds. Seaport handles all asset transfers.
- **Battle-tested security.** Multiple professional audits, billions in volume, years of production use.
- **No liability.** We are building a frontend, not a protocol. The smart contract layer is OpenSea's responsibility.
- **Free order creation.** Seaport uses off-chain signatures — creating an offer costs zero gas.
- **Richer features for free.** ERC-20 support, criteria-based offers, and multi-chain support come built-in.

### Design Principles

- **No backend**: All state lives on-chain or in the URL. Nothing to maintain, no servers to keep running.
- **Minimal dependencies**: Fewer deps = fewer things that break over time.
- **Anti-scam by default**: Token verification and warnings are first-class concerns, not afterthoughts.
- **Seaport SDK**: Use seaport-js for order construction, signing, and fulfillment. The SDK is tied to an immutable contract — it will work as long as Seaport 1.6 exists on-chain, regardless of whether OpenSea continues maintaining it.

---

## 2. V1 Scope

- **Chain**: Ethereum Mainnet (Sepolia for testing)
- **Token types**: ERC-721, ERC-1155, ERC-20 (whitelisted only), and native ETH
- **Swap structure**: Multi-asset <-> multi-asset (each side can have 1+ items)
- **Counterparty**: Optionally restricted to a specific address, or open to anyone
- **Expiration**: Required (default 30 days, configurable in UI)
- **Memo**: Optional short message (max 280 bytes) attached to the order at registration
- **Wallets**: EOAs and single-owner smart wallets (EIP-1271). Multisigs (e.g., Safe) are not supported as **makers** due to the asynchronous multi-signer signing flow, but work fine as **takers** (they call `fulfillOrder` directly as `msg.sender`).
- **Cross-chain**: Out of scope (Seaport is per-chain)

---

## 3. Architecture

### 3.1 Seaport Protocol

Seaport (v1.6) is deployed at a canonical address on Ethereum and all major EVM chains. We interact with it as a consumer — no deployment needed.

**Canonical addresses:**
- Seaport 1.6: `0x0000000000000068F116a894984e2DB1123eB395`
- Conduit Controller: `0x00000000F9490004C11Cef243f5400493c00Ad63`

#### Seaport Order Model

A Seaport order consists of:

```
OrderComponents {
  offerer         // Maker's address
  zone            // Optional restriction contract (address(0) for unrestricted)
  offer[]         // Items the maker is giving
  consideration[] // Items the maker wants + recipients
  orderType       // 0=FULL_OPEN, 1=PARTIAL_OPEN, 2=FULL_RESTRICTED, 3=PARTIAL_RESTRICTED
  startTime       // When the order becomes valid
  endTime         // When the order expires
  zoneHash        // Arbitrary data for zone validation
  salt            // Nonce for uniqueness
  conduitKey      // Which conduit to use for transfers (bytes32(0) for Seaport direct)
  counter         // Maker's current counter (for bulk cancellation)
}

OfferItem / ConsiderationItem {
  itemType        // 0=NATIVE, 1=ERC20, 2=ERC721, 3=ERC1155
  token           // Contract address
  identifierOrCriteria  // Token ID (or merkle root for criteria-based)
  startAmount     // Amount (1 for ERC-721)
  endAmount       // Amount (can differ from start for dutch auctions; same for fixed)
}
```

#### How Our Swaps Map to Seaport

For a simple NFT-for-NFT swap:

1. **Maker creates an order off-chain:**
   - `offer`: The NFTs/tokens the maker is giving
   - `consideration`: The NFTs/tokens the maker wants, with `recipient` set to the maker's address
   - `orderType`: `FULL_RESTRICTED` (2) — always restricted, so the OTCZone validates every order (ERC-20 whitelist + optional taker restriction)
   - `startTime`: now
   - `endTime`: expiration timestamp
   - `conduitKey`: `bytes32(0)` (use Seaport directly for transfers)

2. **Maker signs the order** using EIP-712 typed data signing (no gas).

3. **Maker shares a URL** containing the signed order.

4. **Taker opens the URL**, reviews the swap, approves their assets to Seaport, and calls `fulfillOrder()` — one on-chain transaction that atomically swaps all assets.

#### Taker Restriction

- **Open to anyone**: `orderType: FULL_RESTRICTED`, `zone: OTCZone address`, `zoneHash: bytes32(0)`. The zone still validates ERC-20 whitelist but allows any fulfiller.
- **Restricted taker**: `orderType: FULL_RESTRICTED`, `zone: OTCZone address`, `zoneHash: bytes32(uint256(uint160(takerAddress)))`. The taker address is stored right-aligned in the zoneHash (standard ABI encoding). The zone extracts it via `address(uint160(uint256(zoneHash)))` and validates the fulfiller matches.

**Note:** All orders use `FULL_RESTRICTED` with the OTCZone so that ERC-20 whitelist enforcement always applies. Open-to-anyone orders simply set `zoneHash` to `bytes32(0)`.

The **OTCZone** is a minimal custom contract (~150 lines) deployed once per chain. It combines three responsibilities: taker restriction, ERC-20 whitelist enforcement, and order registration.

Implementation: `contracts/src/OTCZone.sol`

The contract implements Seaport 1.6's `ZoneInterface` (from `seaport-types`). It has no owner, no mutable state after construction, no admin functions, and no access to user funds. The constructor takes a list of whitelisted ERC-20 addresses and the Seaport contract address (used to fetch the EIP-712 domain separator for signature verification).

It serves three purposes:
1. **Taker validation**: Checks that the fulfiller matches the allowed taker in `zoneHash`.
2. **ERC-20 whitelist**: Rejects orders containing non-whitelisted ERC-20 tokens, both at registration and at fulfillment. Whitelist is set at deployment (immutable — no admin can modify it). Mainnet whitelist: WETH, USDC, USDT, USDS, EURC.
3. **Order registry**: `registerOrder` publishes signed orders for discovery. It accepts a single `OrderRegistration` struct (defined outside the contract for clean ABI generation) containing the order hash, maker, taker, offer/consideration items, signature, orderURI, and an optional memo (max 280 bytes). It verifies the maker's EIP-712 signature on-chain using Solady's `SignatureCheckerLib`, which supports EOA signatures (both standard 65-byte and EIP-2098 compact 64-byte) and EIP-1271 contract wallet signatures. The indexed `maker` in the `OrderRegistered` event is cryptographically guaranteed to be the actual order signer — regardless of who submits the transaction. This allows proxy wallets, gas sponsors, and smart wallets to register orders on behalf of makers.

```solidity
struct OrderRegistration {
    bytes32 orderHash;
    address maker;
    address taker;
    SpentItem[] offer;
    ReceivedItem[] consideration;
    bytes signature;
    string orderURI;
    string memo;        // optional, max 280 bytes
}
```

ERC-20 enforcement happens at three layers:
- **Frontend**: The Create page only offers whitelisted ERC-20s (WETH, USDC, USDT, USDS, EURC).
- **Registration**: `registerOrder` reverts if the order contains a non-whitelisted ERC-20.
- **Fulfillment**: `validateOrder` reverts if Seaport tries to settle an order with a non-whitelisted ERC-20.

The `orderURI` field stores the base64-encoded signed order, so the frontend can reconstruct the swap page from the event alone. The `memo` field is emitted in the `OrderRegistered` event and displayed on the swap and offers pages when present.

**Note:** Seaport also allows the offerer to cancel by incrementing their counter (bulk cancel) or cancelling specific orders on-chain.

#### Approvals

Users approve the Seaport contract directly (or a conduit) to transfer their assets. Since we use `conduitKey: bytes32(0)`, approvals go directly to the Seaport contract address.

- ERC-721: `setApprovalForAll(seaportAddress, true)`
- ERC-1155: `setApprovalForAll(seaportAddress, true)`
- ERC-20: `approve(seaportAddress, amount)`

#### Key Differences from Custom Contract

| Aspect | Custom Contract | Seaport |
|--------|----------------|---------|
| Order creation | On-chain tx (gas cost) | Off-chain signature (free) |
| Order data | Stored in tx events | Stored in OTCZone registry events |
| Cancel | On-chain tx per order | On-chain: per-order or bulk (increment counter) |
| Kill switch | Owner-only one-way kill | N/A — not our contract |
| Taker fill | approve + fillOrder | approve + fulfillOrder |
| ERC-20 support | Hardcoded whitelist | Whitelisted via OTCZone |
| Audit status | Unaudited | Extensively audited |

### 3.2 Frontend

#### Tech Stack

- **Framework**: React 19
- **Web3**: ethers.js v6
- **Wallet connection**: Reown AppKit (WalletConnect + injected providers)
- **Styling**: Minimal custom CSS. No CSS framework.
- **NFT data**: Alchemy Portfolio API (wallet NFT enumeration + metadata)
- **NFT metadata fallback**: On-chain tokenURI + IPFS/HTTP resolution
- **Build**: Vite
- **Hosting**: Static site (GitHub Pages, Cloudflare Pages, or IPFS)

#### Pages / Routes

Hash-based routing (works on static hosts, no server config needed).

1. **`#/`** - Home / landing page
   - Brief explanation of what the site does
   - "Create Swap" button

2. **`#/create`** - Create a new swap offer
   - Two columns: "You Send" and "You Receive"
   - Each column: add/remove assets (token address + token ID, or ERC-20 amount)
   - **NFT picker**: "Pick from wallet" button on each side opens a modal grid of NFTs. On the "You Send" side, fetches the connected wallet's NFTs. On the "You Receive" side, fetches the taker's NFTs (grayed out if no taker address is entered; debounce on address input). Uses Alchemy Portfolio API (`POST /data/v1/{apiKey}/assets/nfts/by-address`). Spam NFTs excluded via `excludeFilters: ["SPAM"]`. ERC-1155 tokens with balance > 1 show a quantity picker. Manual entry remains as fallback.
   - Optional: taker address field (with ENS resolution)
   - Expiration (default 30 days)
   - Optional memo (max 280 bytes) — stored on-chain in the `OrderRegistered` event
   - Asset preview with NFT metadata and verification status
   - Click "Create Swap" → approve assets → sign EIP-712 order → register on-chain → generate shareable link

3. **`#/swap/{chainId}/{txHash}`** - View and accept a swap
   - Fetch `OrderRegistered` event from the registration tx receipt
   - Extract signed order from `orderURI` field
   - Display both sides with NFT previews and verification warnings
   - Display memo (if present) in the swap metadata section
   - Validate order on-chain via Seaport `getOrderStatus` (check if filled/cancelled)
   - If valid and user is eligible: approval flow + "Accept Swap" button
   - If user is maker: "Cancel" button
   - Anti-scam education banner (non-dismissable)

4. **`#/offers`** - Browse offers
   - "My Offers" tab (default): orders involving connected wallet
   - "All Open" tab: paginated, all open orders
   - "Completed" tab: filled orders
   - Populated by querying `OrderRegistered` events from OTCZone, cross-referenced with Seaport for order status (filled/cancelled)
   - Offer cards show memo (truncated) when present

#### URL Encoding

Since the signed order is stored on-chain in the `OrderRegistered` event, the URL only needs the chain ID and the registration transaction hash:

```
#/swap/{chainId}/{txHash}
```

Example: `#/swap/1/0x7bd391346f238fc36c19291a1f9678773ca5a47a475814592194802cbec983cb`

The swap page fetches the tx receipt, parses the `OrderRegistered` event to extract the full signed order, and has everything needed to display the swap and call `fulfillOrder`. This is the same pattern used in the current implementation — short, clean URLs with on-chain data retrieval.

#### Order Discovery / Offers Page

The OTCZone contract emits `OrderRegistered` events when makers publish their orders. The offers page queries these events (with the same chunked block-range approach used currently) and cross-references with Seaport's `getOrderStatus` to determine which orders are still open, filled, or cancelled.

- **My Offers**: Filter `OrderRegistered` events where `maker` or `taker` matches the connected wallet.
- **All Open**: All `OrderRegistered` events, filtered client-side to exclude filled/cancelled/expired orders. Paginated.
- **Completed**: Cross-reference with Seaport `OrderFulfilled` events.

Each `OrderRegistered` event contains the `orderURI`, which has everything needed to reconstruct the swap page link.

---

## 4. Seaport Integration Details

All Seaport interactions use the **seaport-js SDK**, which handles order construction, EIP-712 signing, hash computation, and fulfillment parameter generation.

### 4.1 Creating an Order

```js
import { Seaport } from '@opensea/seaport-js'

const seaport = new Seaport(signer)

const { executeAllActions } = await seaport.createOrder({
  zone: OTC_ZONE_ADDRESS,
  zoneHash: takerAddress ? ethers.zeroPadValue(takerAddress, 32) : ethers.ZeroHash,
  offer: [
    { itemType: 2, token: nftAddress, identifier: tokenId },  // ERC-721
  ],
  consideration: [
    { itemType: 2, token: wantedNftAddress, identifier: wantedTokenId, recipient: makerAddress },
  ],
  orderType: 2,  // FULL_RESTRICTED (always, for zone validation)
  endTime: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
})

const order = await executeAllActions()  // Signs the order (no gas)
```

### 4.2 Fulfilling an Order

```js
const { executeAllActions } = await seaport.fulfillOrder({ order })
const tx = await executeAllActions()  // On-chain tx
```

### 4.3 Cancelling an Order

```js
const tx = await seaport.cancelOrders([order.parameters])
```

For bulk cancellation (invalidate all open orders): `seaport.incrementCounter()`.

### 4.4 Checking Order Status

```js
const orderHash = seaport.getOrderHash(order.parameters)
const { isCancelled, totalFilled, totalSize } = await seaport.getOrderStatus(orderHash)
```

- `totalFilled === totalSize` → fully filled
- `isCancelled` → cancelled
- Neither → still open (check `endTime` client-side for expiration)

---

## 5. Anti-Scam Measures

Unchanged from original spec. See sections 4.1-4.3 of the original SPEC.md.

Key points:
- Verified token list (bundled + remote GitHub fetch)
- Verified / Unverified / Suspicious indicators per token
- Impostor detection (same name, different address)
- Full contract addresses always visible, linked to Etherscan
- Non-dismissable education banner on swap page
- ERC-20 whitelist enforced at three layers (frontend, registration, fulfillment) — prevents impostor token scams

### Holdings Verification

The swap page and offers page perform on-chain balance checks to verify that parties actually hold the assets in an order. This prevents users from attempting swaps that will revert.

- **Swap page**: Checks maker's holdings (offer items) and taker's holdings (consideration items) via direct contract calls (`ownerOf` for ERC-721, `balanceOf` for ERC-1155/ERC-20, `provider.getBalance` for native ETH). Missing assets are flagged per-item, and the Accept button is disabled if either side is missing assets.
- **Offers page**: Checks maker holdings for all open offers. Orders where the maker no longer holds assets are sorted to the bottom and visually dimmed.
- **Error priority**: Wrong-taker errors take precedence over holdings errors, which take precedence over the Accept button.

Friendly error messages map known Seaport/Zone revert selectors (e.g., `0x82b42900` → "You are not the authorized taker") to human-readable messages.

### Memo Moderation

The memo field is stored permanently in on-chain event logs and cannot be deleted. Current mitigations:

- **Plain text only.** React's default text rendering escapes HTML/script injection. Never use `dangerouslySetInnerHTML` on memos.
- **No auto-linking.** URLs in memos are displayed as plain text, not clickable links. Prevents phishing.
- **Truncated on offers page.** Limits visibility of spam in the browsing view.

If abuse occurs post-launch, additional mitigations available without contract changes:

- **OrderHash blocklist.** A static array of order hashes in the frontend to suppress specific memos from rendering. Trivial to add.
- **Client-side content filter.** Regex blocklist for slurs or known spam patterns.
- **CSS `unicode-bidi: plaintext` + `direction: ltr`** on memo elements to neutralize RTL override and homograph attacks.
- **Nuclear option.** Stop rendering memos entirely in the frontend — the contract doesn't change, we just hide the field.

---

## 6. NFT Metadata Resolution

Unchanged from original spec. See section 5 of the original SPEC.md.

- On-chain tokenURI/uri call → IPFS/HTTP/data URI resolution
- sessionStorage cache

---

## 7. User Flow

### Creating a Swap

1. User connects wallet
2. Navigates to Create page
3. Adds assets they want to send (contract address + token ID, or ERC-20 amount)
4. Adds assets they want to receive
5. Optionally sets taker address, expiration, and memo
6. Clicks "Create Swap"
7. UI checks and requests approvals for maker's assets to Seaport (gas, per collection)
8. UI constructs Seaport order and prompts EIP-712 signature (**no gas**)
9. UI calls `registerOrder` on OTCZone to publish the order for discovery (gas, cheap)
10. UI generates shareable link containing the signed order
11. User copies link and sends to counterparty

### Accepting a Swap

1. Counterparty opens the shared link
2. UI fetches `OrderRegistered` event from the registration tx receipt and extracts the signed order
3. UI validates: checks Seaport for order status, checks expiration, verifies signature
4. UI displays all assets with verification indicators
5. UI checks on-chain holdings for both maker (offer) and taker (consideration), flagging any missing assets
6. Counterparty reviews the trade
7. Connects wallet
8. UI shows a step-by-step checklist: one step per token approval, plus the final fulfillment action. Each step shows status (pending → signing → confirming → done/failed).
9. Clicks "Accept Swap"
10. UI walks through approval steps, then calls `fulfillOrder` — one transaction, atomic swap
11. Assets are exchanged

### Cancelling a Swap

1. Maker opens the swap link (or navigates from My Offers)
2. Clicks "Cancel"
3. UI calls `seaport.cancel([orderComponents])` — one on-chain tx
4. Order is cancelled on-chain

---

## 8. Future Roadmap

### Mainnet Deployment
- Deploy OTCZone to a vanity address via CREATE2 (e.g., using [create2crunch](https://github.com/0age/create2crunch) with Nick's Factory at `0x4e59b44847b379578588920cA78FbF26c0B4956C`). A recognizable address prefix lets users quickly verify they're signing for the correct contract.
- Register an ENS name (e.g., `otczone.eth`) pointing to the contract address for human-readable identification on block explorers.
- Verify contract source on Etherscan.

### V1.1 - Additional EVM Chains
- Seaport is already deployed on Polygon, Arbitrum, Base, Optimism, etc.
- Add chain selector to the UI
- Chain ID is embedded in the EIP-712 domain, so orders are inherently chain-specific
- Deploy OTCZone per chain (constructor args differ per chain due to token whitelist, so addresses will differ)
- Update constants with chain-specific RPCs, OTCZone addresses, and verified token lists
- Verify contract source on each chain's block explorer

### V1.2 - Criteria-Based Offers
- Seaport natively supports criteria-based offers (e.g., "any Bored Ape")
- Use merkle trees of token IDs, or wildcard (criteria = 0 for any token in collection)
- UI: "I'll trade my X for any token from collection Y"

### V2 - Solana Support
- Separate program, shared UI
- Not related to Seaport

### Client-Side Event Cache
- Cache `OrderRegistered` events in IndexedDB, keyed by zone contract address. Store a block-number watermark; on return visits, only query from the watermark forward.
- Reduces RPC/Alchemy calls from O(full history) to O(blocks since last visit) for repeat visitors. First-time visitors still pay the full scan.
- Best implemented once the contract address is stable (no more redeployments) and the offers page has been migrated to Alchemy or another indexed RPC. Stale zone addresses are naturally orphaned when the address changes.
- Does not help first-time or incognito visitors. Not a substitute for proper indexing at scale, but buys significant headroom on API rate limits.

### Gas Optimization — Compact orderURI Encoding
- Replace JSON + base64 `orderURI` with a compact binary encoding, stripping field names and omitting derivable fields (zone, orderType, conduitKey). Could reduce orderURI calldata by ~60-70%.
- No contract changes needed — `orderURI` is opaque to the contract.
- Trade-off: harder to debug, harder to fork, fragile coupling to Seaport order structure. Not worth it unless users report gas as a pain point.

### Not Planned
- Order book / listing marketplace
- Chat / messaging
- Mobile app (responsive web is sufficient)
- Cross-chain swaps (fundamentally different mechanism)

---

## 9. Forkability & Continuity

### License
GPL-3.0-only. Derivatives must remain open source. See `LICENSE` in the project root.

### No Contract Dependency
Seaport is permissionless and immutable — it cannot be shut down or upgraded out from under us. Anyone can build a frontend that talks to it.

### Frontend Configurability
All environment-specific values in `src/lib/constants.js`:
- Seaport contract address (canonical, same on all chains)
- OTCZone contract address per chain
- OTCZone deploy block per chain (for efficient event queries)
- ERC-20 whitelist addresses per chain
- RPC endpoint URLs per chain
- Verified token list remote URL
- IPFS gateway URL
- Alchemy API key (via `VITE_ALCHEMY_API_KEY` env var)
- Alchemy network identifiers per chain

### External Services
- **Reown AppKit**: Wallet connection (requires project ID via `VITE_REOWN_PROJECT_ID`)
- **Alchemy Portfolio API**: NFT enumeration and metadata for the wallet picker (requires API key via `VITE_ALCHEMY_API_KEY`). The app remains functional without it — manual asset entry is always available as a fallback.
- **Blockchain data**: Public RPC endpoints
- **NFT metadata fallback**: On-chain tokenURI + public IPFS gateways
- **Hosting**: Any static file host
- **Verified token list**: Static JSON file

---

## 10. Dependencies (Exhaustive List)

### Runtime
- **ethers** (v6): Contract interaction, ABI encoding
- **@opensea/seaport-js**: Order construction, EIP-712 signing, fulfillment
- **react** + **react-dom** (v19): UI rendering
- **react-router** (v7): Hash-based routing
- **@reown/appkit** + **@reown/appkit-adapter-ethers**: Wallet connection
- **buffer**: Node.js Buffer polyfill (required by seaport-js in the browser)

### Contract
- **solady**: Signature verification (`SignatureCheckerLib` — EOA + EIP-1271 + EIP-2098 compact)
- **seaport-types**: Seaport interface types (`ZoneInterface`, structs, enums)

### Dev
- **vite**: Build tool
- **@vitejs/plugin-react**: JSX transform
- **foundry** (forge): OTCZone contract development and testing

The only custom contract is the OTCZone (~150 lines), deployed once per chain. Foundry is needed only for this contract.

---

## 11. Open Questions

1. ~~**URL length**~~: **Resolved** — URLs use the `#/swap/{chainId}/{txHash}` format, same as the current implementation. The signed order is stored on-chain in the `OrderRegistered` event and fetched via tx receipt.

2. ~~**Offers page without events**~~: **Resolved** — the OTCZone contract emits `OrderRegistered` events, providing an on-chain index of published orders. The offers page queries these events and cross-references with Seaport for order status.

3. ~~**OTCZone implementation**~~: **Resolved** — implemented and tested. The Seaport 1.6 `ZoneInterface` requires `authorizeOrder`, `validateOrder`, `getSeaportMetadata`, and `supportsInterface`. Our contract implements all four. See `contracts/src/OTCZone.sol` and `contracts/test/OTCZone.t.sol`.

4. ~~**Maker approvals timing**~~: **Resolved** — prompt approvals at order creation. The maker pays gas for approvals, but the order is immediately fillable. This avoids confusion where a taker opens a link and can't fill because the maker forgot to approve.
