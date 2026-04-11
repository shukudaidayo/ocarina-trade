# ocarina.trade - Technical Specification (Seaport Edition)

## 1. Overview

A peer-to-peer trade website for trading NFTs (and whitelisted ERC-20s) directly between two parties. Uses OpenSea's **Seaport protocol** as the onchain settlement layer, with a minimal custom **OTCZone** contract for taker restriction, ERC-20 whitelisting, and order discovery. No backend, no database, no accounts.

### Motivation

Both otc.sudoswap.xyz and opensea.io/deals are dead. The ecosystem needs a simple, durable trade tool. This project prioritizes **longevity** and **minimal maintenance** over feature richness.

### Why Seaport

- **Near-zero custom contract surface.** The only custom contract (OTCZone, ~135 lines) handles taker restriction, ERC-20 whitelisting, signature-verified order discovery — it never touches user funds. Seaport handles all asset transfers.
- **Battle-tested security.** Multiple professional audits, billions in volume, years of production use.
- **No liability.** We are building a frontend, not a protocol. The smart contract layer is OpenSea's responsibility.
- **Cheap order creation.** Seaport uses offchain EIP-712 signatures — the only gas cost is the OTCZone registration transaction for discoverability.
- **Richer features for free.** ERC-20 support, criteria-based offers, and multi-chain support come built-in.

### Design Principles

- **No backend**: All state lives onchain or in the URL. Nothing to maintain, no servers to keep running.
- **Minimal dependencies**: Fewer deps = fewer things that break over time.
- **Anti-scam by default**: Token verification and warnings are first-class concerns, not afterthoughts.
- **Seaport SDK**: Use seaport-js for order construction, signing, and fulfillment. The SDK is tied to an immutable contract — it will work as long as Seaport 1.6 exists onchain, regardless of whether OpenSea continues maintaining it.

---

## 2. V1 Scope

- **Chains**: Ethereum, Base, Polygon, Ink
- **Token types**: ERC-721, ERC-1155, ERC-20 (whitelisted only), and native ETH (taker side only — Seaport requires the caller to provide ETH via `msg.value`, so the maker cannot offer native ETH in a standard `fulfillOrder` flow)
- **Trade structure**: Multi-asset <-> multi-asset (each side can have 1+ items)
- **Counterparty**: Optionally restricted to a specific address, or open to anyone
- **Expiration**: Required (default 30 days, configurable in UI)
- **Memo**: Optional short message (max 280 bytes) attached to the order at registration
- **Wallets**: EOAs and single-owner smart wallets (EIP-1271). Multisigs (e.g., Safe) are not supported as **makers** due to the asynchronous multi-signer signing flow, but work fine as **takers** (they call `fulfillOrder` directly as `msg.sender`).
- **Cross-chain**: Out of scope (each chain has its own OTCZone deployment; Seaport orders are chain-specific)

---

## 3. Architecture

### 3.1 Seaport Protocol

Seaport (v1.6) is deployed at a canonical address on Ethereum and all major EVM chains. We interact with it as a consumer — no deployment needed.

**Canonical addresses:**
- Seaport 1.6: `0x0000000000000068F116a894984e2DB1123eB395`

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

#### How Our Trades Map to Seaport

For a simple NFT-for-NFT trade:

1. **Maker creates an order:**
   - `offer`: The NFTs/tokens the maker is giving
   - `consideration`: The NFTs/tokens the maker wants, with `recipient` set to the maker's address
   - `orderType`: `FULL_RESTRICTED` (2) — always restricted, so the OTCZone validates every order (ERC-20 whitelist + optional taker restriction)
   - `startTime`: now
   - `endTime`: expiration timestamp
   - `conduitKey`: `bytes32(0)` (use Seaport directly for transfers)

2. **Maker signs the order** using EIP-712 typed data signing (no gas).

3. **Order is registered onchain** via `OTCZone.registerOrder()` — one transaction that stores the order for discoverability on the offers page. The signed order is encoded in the transaction as a URI.

4. **Maker shares a URL** containing the chain ID and registration tx hash.

5. **Taker opens the URL**, reviews the trade, approves their assets to Seaport, and calls `fulfillOrder()` — one onchain transaction that atomically exchanges all assets.

#### Taker Restriction

- **Open to anyone**: `orderType: FULL_RESTRICTED`, `zone: OTCZone address`, `zoneHash: bytes32(0)`. The zone still validates ERC-20 whitelist but allows any fulfiller.
- **Restricted taker**: `orderType: FULL_RESTRICTED`, `zone: OTCZone address`, `zoneHash: bytes32(uint256(uint160(takerAddress)))`. The taker address is stored right-aligned in the zoneHash (standard ABI encoding). The zone extracts it via `address(uint160(uint256(zoneHash)))` and validates the fulfiller matches.

**Note:** All orders use `FULL_RESTRICTED` with the OTCZone so that ERC-20 whitelist enforcement always applies. Open-to-anyone orders simply set `zoneHash` to `bytes32(0)`.

The **OTCZone** is a minimal custom contract (~135 lines) deployed once per chain. It combines three responsibilities: taker restriction, ERC-20 whitelist enforcement, and order registration.

Implementation: `contracts/src/OTCZone.sol`

The contract implements Seaport 1.6's `ZoneInterface` (from `seaport-types`). It has no owner, no mutable state after construction, no admin functions, and no access to user funds. The constructor takes a list of whitelisted ERC-20 addresses and the Seaport contract address (used to fetch the EIP-712 domain separator for signature verification).

It serves three purposes:
1. **Taker validation**: Checks that the fulfiller matches the allowed taker in `zoneHash`.
2. **ERC-20 whitelist**: Rejects orders containing non-whitelisted ERC-20 tokens, both at registration and at fulfillment. Whitelist is set at deployment (immutable — no admin can modify it). Whitelists per chain: Ethereum (WETH, USDC, USDT, USDS, EURC), Base (WETH, USDC, USDS, EURC), Polygon (WETH, USDC, USDT0), Ink (WETH, USDC, USDT0).
3. **Order registry**: `registerOrder` publishes signed orders for discovery. It accepts a single `OrderRegistration` struct (defined outside the contract for clean ABI generation) containing the order hash, maker, taker, offer/consideration items, signature, orderURI, and an optional memo (max 280 bytes). It verifies the maker's EIP-712 signature onchain using Solady's `SignatureCheckerLib`, which supports EOA signatures (both standard 65-byte and EIP-2098 compact 64-byte) and EIP-1271 contract wallet signatures. The indexed `maker` in the `OrderRegistered` event is cryptographically guaranteed to be the actual order signer — regardless of who submits the transaction. This allows proxy wallets, gas sponsors, and smart wallets to register orders on behalf of makers.

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
- **Frontend**: The Create page only offers whitelisted ERC-20s for the connected chain.
- **Registration**: `registerOrder` reverts if the order contains a non-whitelisted ERC-20.
- **Fulfillment**: `validateOrder` reverts if Seaport tries to settle an order with a non-whitelisted ERC-20.

The `orderURI` field stores the base64-encoded signed order, so the frontend can reconstruct the trade page from the event alone. The `memo` field is emitted in the `OrderRegistered` event and displayed on the trade detail page when present (not on offer cards, to keep the browse layout clean).

**Note:** Seaport also allows the offerer to cancel by incrementing their counter (bulk cancel) or cancelling specific orders onchain.

#### Approvals

Users approve the Seaport contract directly (or a conduit) to transfer their assets. Since we use `conduitKey: bytes32(0)`, approvals go directly to the Seaport contract address.

- ERC-721: `setApprovalForAll(seaportAddress, true)`
- ERC-1155: `setApprovalForAll(seaportAddress, true)`
- ERC-20: `approve(seaportAddress, amount)`

#### Key Differences from Custom Contract

| Aspect | Custom Contract | Seaport |
|--------|----------------|---------|
| Order creation | On-chain tx (gas cost) | Off-chain signature + onchain registration (gas cost) |
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
- **NFT data**: Alchemy NFT v3 API — `getContractsForOwner` for collection enumeration in the asset picker, `getNFTsForOwner` for fetching individual NFTs within a specific collection. For chains without Alchemy NFT API support (currently Ink), falls back to the Blockscout v2 API (`/api/v2/addresses/{addr}/nft/collections` and `/api/v2/tokens/{contract}/instances`). If `VITE_ALCHEMY_API_KEY` is not set, the asset picker shows no wallet holdings — users can still add assets via manual contract address / token ID entry.
- **NFT metadata**: Alchemy `getNFTMetadata` (pre-cached thumbnails, fast) with onchain tokenURI + IPFS/HTTP/Arweave resolution as fallback
- **Name resolution**: Forward resolution (name → address) for taker input, reverse resolution (address → name) for display throughout the UI. Uses mainnet provider since both systems live on L1. Supports ENS (`.eth` and other ENS TLDs) and `.wei` names (wei-names contract at `0x0000000000696760E15f265e828DB644A0c242EB`). ENS is checked first for reverse resolution; `.wei` is the fallback. For forward resolution, `.wei` names are routed directly to the wei-names contract. When a user enters a name during offer creation, the original name (`.wei` or `.eth`) is preserved and displayed through the review flow.
- **Build**: Vite, with code splitting — heavy dependencies (AppKit, ethers, seaport-js) are lazy-loaded. The homepage renders with only React + Router (~75KB entry chunk). Wallet connection (AppKit) loads asynchronously in the background.
- **Hosting**: Cloudflare Pages (SPA fallback for path-based routing)

#### Pages / Routes

Path-based routing with Cloudflare Pages SPA fallback (`_redirects`).

1. **`/`** - Home / landing page
   - Taker address input ("Who are you trading with?") with ENS/.wei name resolution
   - "Or make an open offer anyone can accept" link
   - "Browse Offers" link
   - No wallet connection UI on this page

2. **`/create`** - Create a new offer (multi-step wizard)
   - Guided wizard flow: Connect → Chain → You Offer → You Want → Review → Submit → Done
   - Step indicator across the top (completed steps clickable, future steps dimmed, all green on success)
   - Full details in `SPEC-CREATE-FLOW.md`

3. **`/offer/{chainId}/{txHash}`** - View and accept an offer
   - Fetch `OrderRegistered` event from the registration tx receipt
   - Extract signed order from `orderURI` field
   - Display both sides with large NFT images, small logos for cash assets, OpenSea/Uniswap links
   - Layout: "From [address/ENS]" headers for each side ("From Anyone" for open taker)
   - Display memo (if present) in the offer metadata section
   - Expiration shown only for open offers; hidden for filled/cancelled/expired
   - For filled offers, show a "Fill tx" link to the block explorer transaction that settled the offer. Found by querying the Blockscout logs API for Seaport `OrderFulfilled` events (topic0: `0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31`) filtered by the offerer address (topic1) and zone address (topic3), then matching the orderHash in the decoded event data.
   - Validate order onchain via Seaport `getOrderStatus` (check if filled/cancelled)
   - If valid and user is eligible: "Accept Offer" button triggers a verification modal listing any unverified NFTs the taker is receiving (maker's offer items) before proceeding, with OpenSea links for review. If all received assets are verified, proceeds directly.
   - If user is maker: "Cancel Offer" button
   - Switch chain warning only shown for open offers
   - For filled offers, when the connected wallet is maker or taker: share section with a client-side Canvas-generated trade image (1200x630, dark theme, both sides' assets with thumbnails, ENS names, "Deal struck!" heading, Ocarina branding). Includes "Share on X" (tweet intent with `@ocarinatrade`, no link), "Copy Image" (clipboard API), and "Save Image" (PNG download)

4. **`/faq`** - FAQ page
   - Scrollable Q&A with sticky sidebar navigation (sidebar hidden on mobile)
   - Sidebar highlights the current section based on scroll position
   - No wallet connection UI on this page

5. **`/offers`** - Browse offers
   - All filters are URL query params, making filtered views shareable (e.g., `/offers?chain=base&category=open&address=vitalik.eth`)
   - Chain filter: Ethereum / Base / Polygon / Ink / All Chains. Accepts chain ID (`?chain=8453`) or name (`?chain=base`)
   - Status filter: "Open" (default) / "All". Open filters to unfilled/uncancelled/unexpired orders
   - Address filter: `0x...` or ENS/.wei name. Shows offers where the address is maker or taker. "Me" button fills the connected wallet's address
   - Collection filter: contract address. Shows offers involving that NFT/token contract on either side
   - All data loaded once on mount (all chains in parallel), all filters applied client-side for instant switching
   - Offer cards show "From [address/ENS]" on each side, asset thumbnails and names (NFT images fetched via Alchemy), token logos for cash, chain name and status badge
   - Populated by querying `OrderRegistered` events from OTCZone, cross-referenced with Seaport for order status (filled/cancelled)
   - Memos are not displayed on offer cards. Memos are visible on the offer detail page only.

#### URL Encoding

Since the signed order is stored onchain in the `OrderRegistered` event, the URL only needs the chain ID and the registration transaction hash:

```
/offer/{chainId}/{txHash}
```

Example: `/offer/1/0x7bd391346f238fc36c19291a1f9678773ca5a47a475814592194802cbec983cb`

The offer page fetches the tx receipt, parses the `OrderRegistered` event to extract the full signed order, and has everything needed to display the offer and call `fulfillOrder`. Uses path-based routing (not hash routing) so that crawlers can read the URL for OG meta tags.

#### Order Discovery / Offers Page

The OTCZone contract emits `OrderRegistered` events when makers publish their orders. Event discovery uses a two-tier strategy:

1. **Blockscout API** (primary): Queries the Blockscout transaction list API (`module=account&action=txlist`) for the OTCZone address, then filters for `registerOrder` calls and parses their logs. Blockscout provides full archive access with no API key and generous rate limits.
2. **RPC fallback**: If Blockscout is unavailable, falls back to `eth_getLogs` with chunked block ranges (9,999 blocks per chunk on Polygon/Base/Ink, 49,999 on Ethereum) scanning from the deploy block forward.

Events are cross-referenced with Seaport's `getOrderStatus` to determine which orders are still open, filled, or cancelled.

- **Open** (default): All `OrderRegistered` events, filtered client-side to exclude filled/cancelled/expired orders. Sorted by validity (valid offers first), then by soonest expiration. Paginated.
- **All**: All `OrderRegistered` events regardless of status. Sorted by creation time (newest first).

Each `OrderRegistered` event contains the `orderURI`, which has everything needed to reconstruct the trade page link.

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
  restrictedByZone: true,  // FULL_RESTRICTED (always, for zone validation)
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
- Verified token list (bundled JSON, supplemented by Alchemy OpenSea safelist status at runtime)
- Verified / Unverified / Suspicious indicators per token
- Impostor detection (same name, different address)
- Full contract addresses always visible, linked to Etherscan
- Verification modal on trade acceptance: when a user clicks "Accept Trade", NFTs the taker is receiving (maker's offer items) are checked for verification status. If any are unverified, a modal lists them with OpenSea links and requires explicit confirmation ("Accept Anyway") before proceeding. Verified-only trades proceed directly.
- Inline unverified warning on offer creation: the review step shows a yellow warning box on any unverified NFT, linking to OpenSea for verification before signing.
- ERC-20 whitelist enforced at three layers (frontend, registration, fulfillment) — prevents impostor token scams

### Spam NFT Detection

The asset picker hides spam collections behind a "Show Potential Spam" toggle. Spam detection uses a hybrid approach:

1. **Alchemy `isSpam` flag**: The `getContractsForOwner` API returns an `isSpam` flag per contract, used as the primary signal.
2. **Heuristic name patterns**: ~20 regex patterns detect common spam indicators in collection names: URLs, claim/reward bait, unicode emoji, dollar amounts, protocol impersonation, fake events, bare EVM addresses, etc. Applied to collections not already flagged by the API.
3. **OpenSea verification override**: Collections with `safelistRequestStatus` of `verified` or `approved` always override spam flags, preventing false positives on legitimate verified collections.

The picker auto-fetches pages until 50 non-spam collections are loaded (or the wallet is exhausted). Spam collections are accessible via the toggle but hidden by default.

### Holdings Verification

The trade page and offers page perform onchain balance checks to verify that parties actually hold the assets in an order. This prevents users from attempting trades that will revert.

- **Trade page**: Checks maker's holdings (offer items) and taker's holdings (consideration items) via direct contract calls (`ownerOf` for ERC-721, `balanceOf` for ERC-1155/ERC-20, `provider.getBalance` for native ETH). Missing assets are flagged per-item, and the Accept button is disabled if either side is missing assets.
- **Offers page**: Checks maker holdings for all open offers. In the "Open" view, orders where the maker no longer holds assets are sorted to the bottom and visually dimmed.
- **Error priority**: Wrong-taker errors take precedence over holdings errors, which take precedence over the Accept button.

Friendly error messages map known Seaport/Zone revert selectors (e.g., `0x82b42900` → "You are not the authorized taker") to human-readable messages.

### Memo Moderation

The memo field is stored permanently in onchain event logs and cannot be deleted. Current mitigations:

- **Plain text only.** React's default text rendering escapes HTML/script injection. Never use `dangerouslySetInnerHTML` on memos.
- **No auto-linking.** URLs in memos are displayed as plain text, not clickable links. Prevents phishing.
- **Trade page only.** Memos are only displayed on the trade detail page, not on offer cards in the browse view.
- **CSS `unicode-bidi: plaintext` + `direction: ltr`** on memo elements to neutralize RTL override and homograph attacks.

If abuse occurs post-launch, additional mitigations available without contract changes:

- **OrderHash blocklist.** A static array of order hashes in the frontend to suppress specific memos from rendering. Trivial to add.
- **Client-side content filter.** Regex blocklist for slurs or known spam patterns.
- **Nuclear option.** Stop rendering memos entirely in the frontend — the contract doesn't change, we just hide the field.

---

## 6. NFT Metadata Resolution

Three-tier resolution strategy:

1. **Alchemy cache**: During the create flow, the asset picker fetches NFT images/names from the Alchemy v3 API. These are attached to the asset object (`_image`, `_name`) and carried through to the review/execute screens without re-fetching.
2. **Alchemy getNFTMetadata**: For contexts without cached data (trade page, offers page), try Alchemy's `getNFTMetadata` v3 endpoint first. Returns pre-cached Cloudinary thumbnails that load quickly and avoid IPFS latency.
3. **On-chain tokenURI fallback**: If Alchemy is unavailable or returns no image, fetch `tokenURI` (ERC-721) or `uri` (ERC-1155) from the contract, then resolve IPFS/HTTP/data URI/Arweave (`ar://`) to fetch JSON metadata.

All results cached in `sessionStorage` to avoid redundant fetches.

---

## 7. User Flow

### Creating a Trade

1. User enters counterparty address (or ENS/.wei name) on the homepage, or chooses "open offer"
2. Connects wallet (auto-skipped if already connected)
3. Selects chain (Ethereum / Base / Polygon / Ink) — triggers wallet network switch. If the wallet has zero native gas on the selected chain, a modal warns that gas is needed and links to Uniswap (or Velodrome for Ink) to buy the native token. User can dismiss with "Continue Anyway".
4. Selects assets to offer from wallet (collectibles grid + cash list, with search/filter and manual entry fallback)
5. Selects assets wanted in return (from taker's wallet if directed, or manual entry if open)
6. Reviews summary: both sides, expiration (default 30 days, configurable), optional memo (max 280 bytes)
7. Clicks "Confirm" → execute screen walks through steps:
   a. Approval steps — one per unique token contract (gas, per collection)
   b. Sign order — EIP-712 signature (**no gas**)
   c. Register order — `registerOrder` on OTCZone (gas, cheap)
8. Success screen shows shareable link
9. User copies link and sends to counterparty

### Accepting a Trade

1. Counterparty opens the shared link
2. UI fetches `OrderRegistered` event from the registration tx receipt and extracts the signed order
3. UI validates: checks Seaport for order status, checks expiration, verifies signature
4. UI displays all assets with verification indicators
5. UI checks onchain holdings for both maker (offer) and taker (consideration), flagging any missing assets
6. Counterparty reviews the trade
7. Connects wallet
8. Clicks "Accept Trade"
9. UI checks NFTs the taker is receiving for verification status. If any are unverified, a modal warns the user and lists unverified assets with OpenSea links. User must confirm or cancel.
10. UI shows a step-by-step checklist: one step per token approval, plus the final fulfillment action. Each step shows status (pending → signing → confirming → done/failed).
11. UI walks through approval steps, then calls `fulfillOrder` — one transaction, atomic trade
12. Assets are exchanged

### Cancelling a Trade

1. Maker opens the trade link (or navigates from the offers page)
2. Clicks "Cancel"
3. UI calls `seaport.cancel([orderComponents])` — one onchain tx
4. Order is cancelled onchain

---

## 8. Deployments

All contracts deployed via CREATE2 (Nick's Factory at `0x4e59b44847b379578588920cA78FbF26c0B4956C`) with a `0x07C00000` vanity prefix. Verified on each chain's block explorer.

| Chain | Address | Whitelisted ERC-20s |
|---|---|---|
| Ethereum | `0x07C0000003f04E1b0b040A5B6c8AAB792d9546fc` | WETH, USDC, USDT, USDS, EURC |
| Base | `0x07C00000090AdB1D14b093C1A6b40135779af27C` | WETH, USDC, USDS, EURC |
| Polygon | `0x07C000000b63fEe6aC08B91ad7aD3d999b28d740` | WETH, USDC, USDT0 |
| Ink | `0x07C00000042fFF5Ad7cDC3A2aF3F4A8708B8CD52` | WETH, USDC, USDT0 |

---

## 9. Future Roadmap

### Taker Refusal
- Allow the designated taker of a directed offer to refuse it, marking it as unfillable and removing it from open offers.
- Requires a new OTCZone function (`refuseOrder`) that stores a `refused[orderHash]` mapping, checked in `validateOrder`.
- Taker verification: either store the taker address at registration time (adds storage cost) or require the caller to pass order parameters so the zone can re-derive the taker from `zoneHash`.
- Only meaningful for directed offers — open offers have no specific taker to refuse.
- Requires OTCZone redeployment on all chains (contract is immutable). Bundle with other contract changes to avoid redundant redeploys.

### Criteria-Based Offers
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

### Privy Cross-App Wallet Support
- Platforms like Courtyard.io (Polygon) and Beezie (Base) use Privy embedded wallets. Their users can't currently connect to external dApps like ours.
- Privy's `@privy-io/cross-app-connect` SDK exposes `toPrivyWalletProvider()`, which returns a standard EIP-1193 provider — compatible with ethers.js, no wagmi/viem required at runtime.
- **Blocker**: Each provider app must enable cross-app sharing in their Privy dashboard. As of 2026-03-20, neither Courtyard nor Beezie has enabled this.
  - Courtyard Privy app ID: `cldj2z0b70001mm08l39me9k5`
  - Beezie Privy app ID: `clozdtqzz0070l80gtizlvizg`
- No code changes needed on our end until a provider enables sharing. Integration is ~50 lines: create an EIP-1193 provider with `toPrivyWalletProvider({ providerAppId, chains })`, wrap in `ethers.BrowserProvider`, and use the signer as normal.
- Privy was acquired by Stripe in mid-2025 — watch for API changes.

### Farcaster / Base App Mini-Apps
- The site's architecture (no backend, hash routing, standard EIP-1193 wallet interface) is compatible with mini-app embedding.
- Main work: detect mini-app context and replace the wallet provider (Farcaster SDK or Coinbase Wallet SDK instead of Reown AppKit). Everything downstream (ethers.js, Seaport calls) stays the same.
- Requires a separate OTCZone deployment per chain (already done for Base, Polygon, and Ink).

### Address Identity Enhancements

#### Ocarina Identicons
- Custom address avatar library: deterministic, parameterized SVG ocarinas generated from the 20 address bytes.
- Visual parameters mapped from byte ranges: shape (sweet potato, pendant, inline, vessel), body color/glaze, size/proportions, hole count and pattern, mouthpiece style, decoration (stripes, dots, cracks, gloss), orientation, background color.
- Billions of unique combinations from 20 bytes of entropy. Same address always renders the same ocarina.
- Zero dependencies — inline SVG, tiny bundle size.
- Displayed next to addresses/ENS names throughout the site to help users visually verify addresses and catch impersonation or wrong-address errors.
- For ENS names with an avatar record set, fetch and display the real avatar instead.

#### EFP (Ethereum Follow Protocol) Integration
- [EFP](https://efp.app/) is an onchain social graph protocol. Each address can have followers, following, and block/mute lists stored onchain.
- Display follower count or "on EFP" indicator next to addresses on the trade page as a trust signal — an address with an established social graph is more likely to be a real, active person.
- Block/mute data could serve as a scam signal: warn if a counterparty has been widely blocked.
- Public API available at ethidentitykit.com — no API key required.
- Complements ocarina identicons: identicons help verify the *right* address, EFP helps assess *trust* in an address.

### Arweave / IPFS Mirror
- Host a static snapshot of the built frontend on Arweave or IPFS as a permanent, censorship-resistant fallback.
- Arweave: upload once, permanent. Use ArNS for a stable name. Cost is negligible for a small static site.
- IPFS: upload and pin (Pinata, Fleek, etc.). Can point an ENS content hash at the CID. Requires re-pinning and updating the hash on each deploy.
- Best as a secondary mirror rather than the primary deployment — every update requires re-uploading and updating references, which adds friction to the deploy flow.
- Reinforces the "if we disappear, the app lives on" promise.

### Not Planned
- Order book / listing marketplace
- Chat / messaging
- Mobile app (responsive web is sufficient)
- Cross-chain trades (fundamentally different mechanism)

---

## 10. Forkability & Continuity

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
- IPFS gateway URL

Alchemy-specific config lives in `src/lib/metadata.js` and `src/components/create-flow/asset-picker.jsx`:
- Alchemy API key (via `VITE_ALCHEMY_API_KEY` env var)
- Alchemy network identifiers per chain (`ALCHEMY_NETWORKS`)

### External Services
- **Reown AppKit**: Wallet connection (requires project ID via `VITE_REOWN_PROJECT_ID`)
- **Alchemy NFT v3 API**: Collection enumeration (`getContractsForOwner`, includes `isSpam` flag for spam detection) and per-collection NFT fetching (`getNFTsForOwner`) for the wallet picker, plus single-NFT metadata fallback (`getNFTMetadata`) on the trade page (requires API key via `VITE_ALCHEMY_API_KEY`). The app remains functional without it — manual asset entry is always available as a fallback.
- **Blockchain data**: Public RPC endpoints
- **NFT metadata fallback**: On-chain tokenURI + public IPFS gateways
- **Hosting**: Any static file host
- **Verified token list**: Bundled static JSON file, supplemented by Alchemy's OpenSea safelist status for runtime verification of unlisted contracts

---

## 11. Dependencies (Exhaustive List)

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

The only custom contract is the OTCZone (~135 lines), deployed once per chain. Foundry is needed only for this contract.

---

## 12. Open Questions

1. ~~**URL length**~~: **Resolved** — URLs use the `/offer/{chainId}/{txHash}` format. The signed order is stored onchain in the `OrderRegistered` event and fetched via tx receipt.

2. ~~**Offers page without events**~~: **Resolved** — the OTCZone contract emits `OrderRegistered` events, providing an onchain index of published orders. The offers page queries these events and cross-references with Seaport for order status.

3. ~~**OTCZone implementation**~~: **Resolved** — implemented and tested. The Seaport 1.6 `ZoneInterface` requires `authorizeOrder`, `validateOrder`, `getSeaportMetadata`, and `supportsInterface`. Our contract implements all four. See `contracts/src/OTCZone.sol` and `contracts/test/OTCZone.t.sol`.

4. ~~**Maker approvals timing**~~: **Resolved** — prompt approvals at order creation. The maker pays gas for approvals, but the order is immediately fillable. This avoids confusion where a taker opens a link and can't fill because the maker forgot to approve.
