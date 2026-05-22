# ocarina.trade - Technical Specification (Seaport Edition)

## 1. Overview

A peer-to-peer trade website for trading NFTs (and whitelisted ERC-20s) directly between two parties. Uses OpenSea's **Seaport protocol** as the onchain settlement layer, with a small custom **OTCRegistry** contract for taker restriction, ERC-20 whitelisting, order publication, and settlement eligibility. No backend, no database, no accounts.

### Motivation

Both otc.sudoswap.xyz and opensea.io/deals are dead. The ecosystem needs a simple, durable trade tool. This project prioritizes **longevity** and **minimal maintenance** over feature richness.

### Why Seaport

- **Small custom contract surface.** The only custom contract, OTCRegistry, handles taker restriction, ERC-20 whitelisting, signature-verified order publication, and settlement eligibility — it never touches user funds. Seaport handles all asset transfers.
- **Battle-tested security.** Multiple professional audits, billions in volume, years of production use.
- **No liability.** We are building a frontend, not a protocol. The smart contract layer is OpenSea's responsibility.
- **Cheap order creation.** Seaport uses offchain EIP-712 signatures — the only gas cost is the OTCRegistry registration transaction for publication and settlement eligibility.
- **Richer features for free.** ERC-20 support, criteria-based offers, and multi-chain support come built-in.

### Design Principles

- **No backend**: All state lives onchain or in the URL. Nothing to maintain, no servers to keep running.
- **Minimal dependencies**: Fewer deps = fewer things that break over time.
- **Anti-scam by default**: Token verification and warnings are first-class concerns, not afterthoughts.
- **Seaport SDK + direct Seaport calls**: Use seaport-js for order construction, signing, hashing, and cancellation helpers; use direct ethers calls for fulfillment so pre-fill simulation and the final transaction use the same Seaport calldata. Seaport 1.6 is immutable onchain, so these calls remain durable regardless of whether OpenSea continues maintaining the SDK.

---

## 2. V1 Scope

- **Chains**: Ethereum, Base, Polygon, Ink
- **Token types**: ERC-721, ERC-1155, ERC-20 (whitelisted only), and native ETH (taker side only — Seaport requires the caller to provide ETH via `msg.value`, so the maker cannot offer native ETH in a standard `fulfillOrder` flow). ERC-721 and ERC-1155 collection-wide wildcard criteria items are supported as "Any token" items for single-contract collections.
- **Trade structure**: Multi-asset <-> multi-asset (each side can have 1+ items)
- **Counterparty**: Optionally restricted to a specific address, or open to anyone
- **Expiration**: Required (default 30 days, configurable in UI)
- **Memo**: Optional short message (max 280 bytes) attached to the order at registration
- **Wallets**: EOAs and single-owner smart wallets (EIP-1271). Multisigs (e.g., Safe) are not supported as **makers** due to the asynchronous multi-signer signing flow, but work fine as **takers** (they call `fulfillOrder` directly as `msg.sender`).
- **Cross-chain**: Out of scope (each chain has its own OTCRegistry deployment; Seaport orders are chain-specific)

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
  itemType        // 0=NATIVE, 1=ERC20, 2=ERC721, 3=ERC1155, 4=ERC721_WITH_CRITERIA, 5=ERC1155_WITH_CRITERIA
  token           // Contract address
  identifierOrCriteria  // Token ID, merkle root, or 0 for wildcard criteria
  startAmount     // Amount (must be nonzero; 1 for ERC-721)
  endAmount       // Final amount; Ocarina V1 requires this to equal startAmount
}
```

#### How Our Trades Map to Seaport

For a simple NFT-for-NFT trade:

1. **Maker creates an order:**
   - `offer`: The NFTs/tokens the maker is giving
   - `consideration`: The NFTs/tokens the maker wants, with every `recipient` set to the maker's address
   - `orderType`: `FULL_RESTRICTED` (2) — always restricted, so the OTCRegistry validates every order (ERC-20 whitelist + optional taker restriction)
   - `startAmount == endAmount` and `startAmount > 0` for every item — fixed, nonzero swaps only; variable-price/dutch-style orders and zero-amount items are rejected by OTCRegistry
   - Criteria-based "Any token" items use wildcard criteria (`identifierOrCriteria == 0`) against a single NFT contract. ERC-721 criteria quantity is represented as multiple `ERC721_WITH_CRITERIA` items, each with amount `1`; for example, "two of any Milady Makers" is two separate wildcard ERC-721 criteria items for the Milady contract.
   - `startTime`: now; OTCRegistry rejects future `startTime` values at registration so published orders are immediately fulfillable unless later filled, cancelled, expired, or invalidated by maker state
   - `endTime`: expiration timestamp; must be greater than or equal to `startTime`
   - `conduitKey`: `bytes32(0)` — use Seaport directly for transfers; nonzero conduit keys are rejected by OTCRegistry

2. **Maker signs the order** using EIP-712 typed data signing (no gas).

3. **Order is registered onchain** via `OTCRegistry.registerOrder()` — one transaction that publishes the order for the offers page and makes it eligible to settle through OTCRegistry.

4. **Maker shares a URL** containing the chain ID and registration tx hash.

5. **Taker opens the URL**, reviews the trade, resolves any criteria items to concrete token IDs, approves their assets to Seaport, optionally authorizes any explicit cash tip, and fulfills the order — one onchain transaction that atomically exchanges all assets. Standard no-tip exact-item orders use `fulfillOrder`; criteria orders and tipped orders use `fulfillAdvancedOrder`.

#### Taker Restriction

- **Open to anyone**: `orderType: FULL_RESTRICTED`, `zone: OTCRegistry address`, `zoneHash` has lower 160 bits set to zero. The zone still validates ERC-20 whitelist but allows any fulfiller.
- **Restricted taker**: `orderType: FULL_RESTRICTED`, `zone: OTCRegistry address`, `zoneHash` has the taker address stored in the lower 160 bits. OTCRegistry extracts the taker via `address(uint160(uint256(zoneHash)))` and validates the fulfiller matches.

The upper 96 bits of `zoneHash` are reserved for Ocarina metadata. V1 packs the original consideration item count into `zoneHash` so the registry can distinguish signed consideration from fulfillment-time tips without storing a second mapping:

```
bits 0..159    allowed taker address (zero for open offers)
bits 160..191  originalConsiderationCount
bits 192..199  zoneHash version (1)
bits 200..255  reserved, must be zero
```

Registration requires `zoneHash.version == 1`, reserved bits equal zero, and `originalConsiderationCount == components.consideration.length`. The Seaport order hash commits to `zoneHash`, so these fields are signed by the maker as part of the order.

**Note:** All orders use `FULL_RESTRICTED` with the OTCRegistry so that ERC-20 whitelist enforcement always applies. Open-to-anyone orders set only the metadata bits and leave the lower 160 taker bits as zero.

**Lifecycle invariant:** An order using `zone = OTCRegistry` must successfully pass `registerOrder` before it can settle. Registration enforces order shape, zoneHash metadata, and publication authorization; `authorizeOrder` enforces taker restriction; `validateOrder` enforces prior registration, ERC-20 whitelist policy, and explicit tip authorization during settlement. A maker can construct and sign a direct Seaport order with `zone = OTCRegistry`, but it cannot settle through OTCRegistry unless the exact Seaport `orderHash` was registered first.

The **OTCRegistry** is a small custom contract deployed once per chain. It combines three responsibilities: taker restriction, ERC-20 whitelist enforcement, and order registration.

Implementation: `contracts/src/OTCRegistry.sol`

The contract implements Seaport 1.6's `ZoneInterface` (from `seaport-types`). It has no owner, no mutable state after construction except the registration ledger, no admin functions, and no access to user funds. The registration ledger blocks duplicate publication and acts as the settlement allowlist checked during fulfillment. The constructor takes a list of whitelisted ERC-20 addresses and the Seaport contract address, rejecting a zero Seaport address or zero whitelist token entry. OTCRegistry owns its EIP-712 domain (`name: "OTCRegistry"`, `version: "1"`) rather than reusing Seaport's; the Seaport address is stored to gate zone callbacks (`msg.sender == seaport`) and to call `ISeaport.getOrderHash` during registration.

It serves three purposes:
1. **Taker validation**: `authorizeOrder` (pre-transfer) checks that the fulfiller matches the allowed taker encoded in the lower 20 bytes of `zoneHash` (the Seaport order's zoneHash, not a registration field). Open offers use a zero taker field; directed offers use the right-aligned taker address. The upper 96 bits contain Ocarina metadata, including the original consideration count used for tip detection.
2. **ERC-20 whitelist + item-standard validation**: Rejects orders containing non-whitelisted ERC-20 tokens at registration and fulfillment. OTCRegistry also enforces declared item shape at registration: all registered items must have fixed, nonzero amounts (`startAmount == endAmount` and `startAmount > 0`) and `conduitKey == bytes32(0)`; `startTime <= block.timestamp <= endTime`; all consideration recipients must equal the maker; ERC-20 items must have `identifier == 0`; ERC-721 items must support ERC-165 `IERC721` and have amount `1`; ERC-1155 items must support ERC-165 `IERC1155`; native items must use `token == address(0)` and `identifier == 0`; native items are allowed only on the consideration side, because Seaport fulfillment supplies native ETH from the caller via `msg.value` and cannot transfer native ETH from the maker's offer side. These checks block ordinary mislabeling and malformed orders, but ERC-165 is self-attested by the token contract and is not an authenticity or transferability guarantee for arbitrary malicious or policy-gated NFTs. NFT transferability policies, including ERC-5192, ERC-5484, ERC-6454, ERC721-C, ERC1155-C, criteria-item ambiguity, maker/taker-specific transfer rules, and other collection-specific restrictions are handled by frontend warnings and optional simulations rather than by the registry. Whitelist is set at deployment (immutable — no admin can modify it). Whitelisted ERC-20s must be standard, non-rebasing, non-fee-on-transfer tokens: OTCRegistry checks whitelist membership, but it does not measure sender or recipient balance deltas during Seaport settlement. Adding a rebasing token, transfer-fee token, hook-based token, or otherwise non-standard ERC-20 would make the whitelist assumption unsafe and requires a new security review before deployment. Whitelists per chain: Ethereum (WETH, USDC, USDT, USDS, EURC), Base (WETH, USDC, USDS, EURC), Polygon (WETH, USDC, USDT0), Ink (WETH, USDC, USDT0).
3. **Order registry**: `registerOrder` publishes Seaport-validated orders for discovery and is mandatory for settlement through OTCRegistry. It accepts `OrderComponents` (the full Seaport order parameters) and a `seaportSignature`, plus an optional `memo` (max 280 bytes) and an OTCRegistry `signature`. The contract requires `components.counter` to equal Seaport's current counter for the offerer, then calls `ISeaport(seaport).getOrderHash(components)` to derive the canonical order hash — no EIP-712 reimplementation. It asserts `components.zone == address(this)` and `components.orderType == FULL_RESTRICTED` before proceeding, so the emitted event is trustworthy by construction for all consumers without client-side cross-checks. The expiry check uses `components.endTime` directly; there is no separate `deadline` field. The maker's EIP-712 registration signature covers `(orderHash, keccak(seaportSignature), keccak(memo))` under OTCRegistry's domain: `orderHash` transitively binds all order fields (offerer, taker via zoneHash, endTime, etc.), and binding `seaportSignature` prevents a front-runner from substituting a bad Seaport sig using a stolen registration sig. The contract then calls `Seaport.validate()` before emitting. In the normal path this verifies the Seaport signature and marks the order hash validated in Seaport storage; if the same order hash was already validated directly in Seaport, Seaport may skip re-verifying the supplied signature bytes, but the bytes are not emitted and are not part of the public order payload. Consumers fulfill registered orders with an empty Seaport signature (`0x`) and treat the validated order hash plus registry event as the publication proof. Solady's `SignatureCheckerLib` supports EOA signatures (both standard 65-byte and EIP-2098 compact 64-byte) and EIP-1271 contract wallet signatures. Submission is permissionless — `msg.sender` is unchecked — which supports proxy wallets, gas sponsors, and mini-app relayers submitting on the maker's behalf. A `registered[orderHash]` mapping blocks replay and is checked during fulfillment. Seaport's order hash commits to the offerer, so the same order hash can only land once, a would-be squatter can't register the legitimate maker's order without that maker's OTCRegistry signature, and unregistered Seaport orders cannot settle through OTCRegistry. The `registered` slot is written before the signature check (CEI ordering) as defense-in-depth against any future ERC-1271 callback that isn't a staticcall and so Seaport's validation path can observe the registered order if it invokes the zone. An expired order reverts before the slot is written, so a maker can create a fresh Seaport order (new `endTime` → new `orderHash`) and publish.

```solidity
struct OrderRegistration {
    OrderComponents components;  // Full Seaport order parameters
    bytes seaportSignature;      // Seaport EIP-712 signature used for registration validation
    bytes signature;             // OTCRegistry EIP-712 registration signature
    string memo;                 // optional, max 280 bytes
}
```

ERC-20 enforcement happens at three layers:
- **Frontend**: The Create page only offers whitelisted ERC-20s for the connected chain.
- **Registration**: `registerOrder` rejects orders containing non-whitelisted ERC-20s before emitting, keeping the registry free of unfillable entries. It also rejects variable-amount items (`startAmount != endAmount`), zero-amount items, maker-side native items, and orders where `startTime > endTime`. Registered Ocarina offers are fixed, nonzero swaps within a valid time range. The registry checks that ERC-721/ERC-1155 items support the declared ERC-165 interface, which catches ordinary ERC-20-as-NFT mislabeling and malformed item declarations. A malicious token contract can still self-report ERC-165 support, so arbitrary NFT authenticity and transfer-policy compatibility are handled by frontend verification indicators, warnings, and optional simulations rather than by the registry alone.
- **Fulfillment**: `validateOrder` requires the Seaport `orderHash` to have been registered and rechecks ERC-20 whitelist status for any ERC-20 items Seaport presents during settlement. If Seaport presents more consideration items than the original count encoded in `zoneHash`, the extras are treated as tips and must be explicitly authorized by the fulfiller. Because Seaport reverts atomically on callback failure, no funds can move for an unregistered order, rejected token, or unauthorized tip.

`OrderRegistered` emits `OrderComponents` as structured ABI-encoded fields, but does not emit `seaportSignature`. Because `registerOrder` pre-validates the order hash in Seaport, the frontend reconstructs the Seaport order from the emitted parameters with `signature: "0x"`. The canonical authorization after registration is the validated Seaport order hash plus the registry event; the original Seaport signature is only registration calldata. The `memo` field is emitted in the `OrderRegistered` event and displayed on the trade detail page when present (not on offer cards, to keep the browse layout clean).

**Note:** Seaport also allows the offerer to cancel by incrementing their counter (bulk cancel) or cancelling specific orders onchain.

#### Approvals

Users approve the Seaport contract directly to transfer their assets. Since Ocarina orders use `conduitKey: bytes32(0)`, approvals go directly to the Seaport contract address.

- ERC-721: `setApprovalForAll(seaportAddress, true)`
- ERC-1155: `setApprovalForAll(seaportAddress, true)`
- ERC-20: `approve(seaportAddress, amount)`

#### Criteria-Based Items

The frontend supports collection-wide wildcard criteria items, displayed as **Any token**. These are encoded using Seaport criteria item types with `identifierOrCriteria == 0`, meaning any token ID from the specified contract can satisfy the item. The UI intentionally does not currently build Merkle-root criteria sets.

Criteria items are contract-specific. In the NFT picker, `Add Any Token` appears only when the drilled collection maps to exactly one underlying contract. For merged display groups that combine multiple contracts (for example ENS-style grouped collections), the button is hidden because the contract to sign against would be ambiguous. Users can still create a criteria item for a specific contract through manual entry.

Multiple wildcard ERC-721 items from the same contract are allowed by adding multiple `Any token` entries. Because Seaport and OTCRegistry require ERC-721 amount `1`, each desired ERC-721 must be represented as its own criteria item. On the offer detail page, the fulfiller must enter a concrete token ID for each criteria item before accepting. The UI rejects duplicate concrete token IDs for multiple ERC-721 criteria items from the same contract, since the same ERC-721 cannot satisfy two separate items in one atomic fill. ERC-1155 criteria items may use an amount greater than `1` and are resolved to a concrete token ID at fulfillment.

#### Optional Fulfillment Tips

Seaport allows a fulfiller to append extra consideration items at fulfillment time. OTCRegistry permits this only for explicit, fulfiller-authorized cash tips. Tips are optional and are never part of the maker's signed order terms.

There is a distinction between the protocol rule and this site's UI:

- **Protocol / registry**: Any frontend may append native or whitelisted ERC-20 tip items to any recipient, but only if the fulfiller signs the exact appended tip set. NFT tips, criteria tips, malformed cash tips, non-whitelisted ERC-20 tips, and unsigned appended consideration are rejected by `validateOrder`.
- **Current ocarina.trade site**: The only exposed tip UI is an optional "Support Ocarina - $5 USDC" checkbox on chains with a configured USDC address. The site signs a `TipAuthorization` only for that fixed USDC amount and the configured Ocarina support recipient. It does not currently expose custom tip recipients, custom amounts, native tips, or third-party frontend tips, even though the registry protocol can validate them.

Tip policy:
- No-tip fills require no extra signature and can use the cheapest applicable Seaport method (`fulfillOrder` for exact-item orders, `fulfillAdvancedOrder` for criteria orders).
- Tipped fills must use `fulfillAdvancedOrder`, because Seaport passes `AdvancedOrder.extraData` to the zone and standard `fulfillOrder` has no `extraData` field.
- Tips are detected when `zoneParameters.consideration.length > originalConsiderationCount`, where `originalConsiderationCount` is decoded from `zoneHash`.
- Tip items are the consideration items at indices `[originalConsiderationCount, zoneParameters.consideration.length)`, in the exact order supplied to Seaport.
- Protocol-level tips may be paid to the maker, Ocarina, another frontend, or any other recipient, but only if the fulfiller signs the exact tip set.
- Tip item types are limited to `NATIVE` and whitelisted `ERC20`. NFT tips, criteria tips, variable-amount tips, zero-amount tips, ERC-20 tips with nonzero identifiers, and non-whitelisted ERC-20 tips are rejected.
- If there are no tip items, `extraData` must be empty. Nonempty `extraData` without tips is rejected to avoid ambiguous third-party conventions.
- The contract does not impose a maximum number of tips; the frontend may impose a display/UX cap.

The fulfiller's tip authorization is an offchain EIP-712 signature under the OTCRegistry domain (`name: "OTCRegistry"`, `version: "1"`, current `chainId`, and the registry address). Signing is gasless; verification gas is paid only by tipped fills. The signed struct is:

```solidity
struct TipItem {
    uint8 itemType;
    address token;
    uint256 identifier;
    uint256 amount;
    address recipient;
}

struct TipAuthorization {
    bytes32 orderHash;
    address fulfiller;
    TipItem[] tips;
    uint256 deadline;
}
```

The signed `tips` array is the exact appended `TipItem[]` in order, using the standard EIP-712 nested-array encoding. `extraData` is `abi.encode(uint256 deadline, bytes signature)`. `validateOrder` decodes `extraData`, checks `deadline >= block.timestamp`, recomputes the canonical EIP-712 array hash from the appended consideration items, builds the `TipAuthorization` digest with `fulfiller = zoneParameters.fulfiller`, and verifies the signature with `SignatureCheckerLib.isValidSignatureNow(zoneParameters.fulfiller, digest, signature)`.

This does not make a malicious frontend impossible, because a hostile UI can still ask the user to sign a harmful typed message and display it poorly. It does prevent a frontend from silently hiding tips only inside Seaport calldata, and it gives wallets and ERC-7730 metadata a clear signing surface for human-readable tip prompts.

#### Key Differences from Custom Contract

| Aspect | Custom Contract | Seaport |
|--------|----------------|---------|
| Order creation | On-chain tx (gas cost) | Off-chain signature + onchain registration (gas cost) |
| Order data | Stored in tx events | Stored in OTCRegistry registry events |
| Cancel | On-chain tx per order | On-chain: per-order or bulk (increment counter) |
| Kill switch | Owner-only one-way kill | N/A — not our contract |
| Taker fill | approve + fillOrder | approve + fulfillOrder |
| ERC-20 support | Hardcoded whitelist | Whitelisted via OTCRegistry |
| Audit status | Unaudited | Extensively audited |

### 3.2 Frontend

#### Tech Stack

- **Framework**: React 19
- **Web3**: ethers.js v6
- **Wallet connection**: Reown AppKit (WalletConnect + injected providers)
- **Styling**: Minimal custom CSS. No CSS framework.
- **NFT data**: Alchemy NFT v3 API — `getContractsForOwner` for collection enumeration in the asset picker, `getNFTsForOwner` for fetching individual NFTs within a specific collection. For chains without Alchemy NFT API support (currently Ink, plus Sepolia in dev constants), falls back to the Blockscout v2 API (`/api/v2/addresses/{addr}/nft/collections` and `/api/v2/tokens/{contract}/instances`). If `VITE_ALCHEMY_API_KEY` is not set, Alchemy-backed chains show no wallet holdings in the picker, while Blockscout-backed chains can still enumerate holdings. Users can always add assets via manual contract address / token ID entry.
- **Criteria item creation**: The asset picker lets users add `Any token` criteria items from single-contract collection drill-down views, or from manual entry by providing a concrete contract address and selecting the criteria option. Merged collections that aggregate multiple contracts do not show the collection-level `Any token` action.
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
   - Reconstruct the validated Seaport order from the emitted `OrderComponents` with empty signature `0x`
   - Display both sides with large NFT images, small logos for cash assets, OpenSea/Uniswap links
   - Layout: "From [address/ENS]" headers for each side ("From Anyone" for open taker)
   - Display memo (if present) in the offer metadata section
   - Expiration shown only for open offers; hidden for filled/cancelled/expired
   - For filled offers, show a "Fill tx" link to the block explorer transaction that settled the offer. Found by querying the Blockscout logs API for Seaport `OrderFulfilled` events (topic0: `0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31`) filtered by the offerer address (topic1) and zone address (topic2), then matching the orderHash in the decoded event data.
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
   - Populated by querying `OrderRegistered` events from OTCRegistry, cross-referenced with Seaport for order status (filled/cancelled)
   - If event discovery falls back to the partial RPC scan for any chain, the page remains usable and shows a disclaimer that only recent offers may be present
   - Memos are not displayed on offer cards. Memos are visible on the offer detail page only.

#### URL Encoding

Since the validated order parameters are stored onchain in the `OrderRegistered` event, the URL only needs the chain ID and the registration transaction hash:

```
/offer/{chainId}/{txHash}
```

Example: `/offer/1/0x7bd391346f238fc36c19291a1f9678773ca5a47a475814592194802cbec983cb`

The offer page fetches the tx receipt, parses the `OrderRegistered` event to extract the order parameters, and has everything needed to display the offer and call `fulfillOrder` with `signature: "0x"` because registration already validated the order hash in Seaport. The parser must only accept an `OrderRegistered` log whose `log.address` equals the canonical `OTCRegistry` address for the URL's `chainId`; same-ABI events from any other contract are ignored. After decoding, the frontend also rechecks that the order's `zone` is the same registry address, that `orderType` is `FULL_RESTRICTED`, and that seaport-js derives the emitted `orderHash` from the decoded parameters. Uses path-based routing (not hash routing) so that crawlers can read the URL for OG meta tags.

#### Order Discovery / Offers Page

The OTCRegistry contract emits `OrderRegistered` events when makers publish their orders. Event discovery uses a two-tier strategy:

1. **Blockscout API** (primary): Queries the Blockscout transaction list API (`module=account&action=txlist`) for the OTCRegistry address, then filters for `registerOrder` calls and parses their logs. Blockscout provides full archive access with no API key and generous rate limits.
2. **Partial RPC fallback**: If Blockscout is unavailable, falls back to `eth_getLogs` over a recent block window only, not full history. The current frontend scans from `max(latestBlock - 49,999, deployBlock)` to `latestBlock`, chunked at 9,999 blocks on Polygon/Base/Ink and 49,999 blocks on Ethereum/Sepolia. Results from this path are marked `_partial`, and `/offers` shows a "Only showing recent offers. Older offers may be missing." disclaimer if any chain used the fallback.

The RPC fallback is intentionally partial. It keeps the static frontend useful during Blockscout/API outages without forcing first-time visitors to make archive-scale public RPC scans. Older offers may be absent until the primary Blockscout path is available again.

Events are cross-referenced with Seaport's `getOrderStatus` to determine which orders are still open, filled, or cancelled.

- **Open** (default): All `OrderRegistered` events, filtered client-side to exclude filled/cancelled/expired orders. Sorted by validity (valid offers first), then by soonest expiration. Paginated.
- **All**: All `OrderRegistered` events regardless of status. Sorted by creation time (newest first).

Each `OrderRegistered` event contains structured `OrderComponents`, which have everything needed to reconstruct the trade page link and fulfillment payload for an already-validated order.

---

## 4. Seaport Integration Details

Order construction, EIP-712 signing, hash computation, and cancellation use the **seaport-js SDK**. Fulfillment uses direct ethers calls to Seaport's `fulfillOrder` / `fulfillAdvancedOrder` so the frontend can `staticCall` the exact same calldata before submitting the final transaction.

### 4.1 Creating an Order

```js
import { Seaport } from '@opensea/seaport-js'

const seaport = new Seaport(signer)

function encodeZoneHash({ takerAddress, originalConsiderationCount }) {
  const taker = takerAddress ? BigInt(takerAddress) : 0n
  const count = BigInt(originalConsiderationCount)
  const version = 1n
  return ethers.toBeHex(taker | (count << 160n) | (version << 192n), 32)
}

const consideration = [
  { itemType: 2, token: wantedNftAddress, identifier: wantedTokenId, recipient: makerAddress },
]

const { executeAllActions } = await seaport.createOrder({
  zone: OTC_ZONE_ADDRESS,
  zoneHash: encodeZoneHash({
    takerAddress,
    originalConsiderationCount: consideration.length,
  }),
  offer: [
    { itemType: 2, token: nftAddress, identifier: tokenId },  // ERC-721
  ],
  consideration,
  restrictedByZone: true,  // FULL_RESTRICTED (always, for zone validation)
  conduitKey: ethers.ZeroHash,  // bytes32(0), approve Seaport directly
  endTime: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
})

const order = await executeAllActions()  // Signs the order (no gas)
```

### 4.2 Fulfilling an Order

No-tip exact-item orders use `fulfillOrder`:

```js
await seaportContract.fulfillOrder.staticCall(order, ethers.ZeroHash, { value })
const tx = await seaportContract.fulfillOrder(order, ethers.ZeroHash, { value })  // On-chain tx
```

Criteria orders and tipped orders use `fulfillAdvancedOrder`:

```js
const advancedOrder = {
  parameters: {
    ...order.parameters,
    // For tipped fills, append tips after the original consideration items.
    consideration: [...order.parameters.consideration, ...tips],
    totalOriginalConsiderationItems: order.parameters.consideration.length,
  },
  signature: "0x",
  extraData: tips.length ? encodedTipAuthorization : "0x",
  numerator: 1,
  denominator: 1,
}

await seaportContract.fulfillAdvancedOrder.staticCall(
  advancedOrder,
  criteriaResolvers,
  ethers.ZeroHash,
  ethers.ZeroAddress,
  { value }
)
const tx = await seaportContract.fulfillAdvancedOrder(
  advancedOrder,
  criteriaResolvers,
  ethers.ZeroHash,
  ethers.ZeroAddress,
  { value }
)
```

When `tips.length > 0`, the frontend must first ask the fulfiller for the gasless `TipAuthorization` EIP-712 signature and ABI-encode `(deadline, signature)` into `extraData`. Native tip amounts are included in `msg.value` alongside any original native consideration. When `tips.length == 0`, `extraData` must be `0x`.

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

**Counter-invalidated orders:** `incrementCounter()` bulk-cancels all of a maker's orders by advancing their counter, but these orders return `isCancelled=false, totalFilled=0` from `getOrderStatus`. Detection is handled by a separate `seaport.getCounter(maker)` call in `deriveOrderStatus` (`src/lib/contract.js`): if the live counter exceeds `order.parameters.counter`, the order is treated as cancelled. On the offers page, counters are pre-fetched per unique maker (deduplicated) before the status batch. On the offer detail page, `getCounter` is fetched in parallel with `getOrderStatus` and degrades gracefully on RPC failure.

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
- ERC-20 whitelist enforced at three layers (frontend, registration, fulfillment), with registration-time item-shape checks and ERC-165 checks for declared NFT items, including the ERC-165 invalid-interface probe (`0xffffffff`). These checks block ordinary ERC-20-as-NFT mislabeling and malformed orders, but they do not prove that an arbitrary unverified token contract is honest or fillable. Transferability policies such as ERC-5192, ERC-5484, ERC-6454, ERC721-C/ERC1155-C, criteria-specific restrictions, and maker/taker-specific restrictions are handled by frontend warnings and by simulating the exact Seaport fill after approvals but before the final fulfillment transaction. The ERC-20 whitelist is also a deployment-time security boundary: only standard, non-rebasing, non-fee-on-transfer tokens should be whitelisted, because OTCRegistry does not verify balance deltas around Seaport transfers.
- **Explicit tip authorization.** Tipped fills require a separate gasless `TipAuthorization` signature from the fulfiller over the exact appended cash tip items. This prevents hidden tips from being added only inside Seaport calldata. Ocarina's own frontend displays tips before signing, rejects NFT tips, and rejects nonempty Seaport `extraData` when no tips are present.
- **Trustworthy event log by construction.** `registerOrder` verifies all critical invariants onchain before emitting: `zone == address(this)` and `orderType == FULL_RESTRICTED` are asserted directly; `orderHash` is derived by delegating to `ISeaport(seaport).getOrderHash(components)` rather than re-implementing EIP-712 (no divergence possible); `taker` is extracted from the low 20 bytes of `zoneHash` by the contract and the original consideration count is extracted from the upper metadata bits. The maker's EIP-712 registration signature covers `(orderHash, seaportSignature, memo)` — `orderHash` transitively binds all `OrderComponents` fields, and `seaportSignature` is bound directly to prevent a front-runner from substituting a bad Seaport signature using the maker's registration sig. `seaportSignature` is not emitted; it is only used to validate the order hash through Seaport before publication. Frontend receipt parsing must first verify that the log was emitted by the canonical `OTCRegistry` address for the URL's `chainId`; after decoding, it locally rechecks the registry zone, restricted order type, zoneHash metadata, and derived Seaport order hash, then fulfills with `signature: "0x"` because the order is already validated. Events are deduped by `orderHash` (earliest-wins), and `validateOrder` rejects any `orderHash` not present in `registered`, so replay-overwrite spoofing is impossible and unregistered direct Seaport orders cannot settle through OTCRegistry.
- **Registration-gated settlement.** OTCRegistry is not a general-purpose Seaport policy zone. Direct Seaport orders can name the OTCRegistry as their zone, but they are unfillable unless the exact order was published through `registerOrder` first.

### Spam NFT Detection

The asset picker hides spam collections behind a "Show Potential Spam" toggle. Spam detection uses a hybrid approach:

1. **Alchemy `isSpam` flag**: The `getContractsForOwner` API returns an `isSpam` flag per contract, used as the primary signal.
2. **Heuristic name patterns**: ~20 regex patterns detect common spam indicators in collection names: URLs, claim/reward bait, unicode emoji, dollar amounts, protocol impersonation, fake events, bare EVM addresses, etc. Applied to collections not already flagged by the API.
3. **OpenSea verification override**: Collections with `safelistRequestStatus` of `verified` or `approved` always override spam flags, preventing false positives on legitimate verified collections.

The picker auto-fetches pages until 250 non-spam collections are loaded (or the wallet is exhausted). Each "Load More Collections" action also fetches up to the next 250 non-spam collections. Spam collections are accessible via the toggle but hidden by default.

### Holdings Verification

The trade page and offers page perform onchain balance checks to verify that parties actually hold the assets in an order. This prevents users from attempting trades that will revert.

- **Trade page**: Checks maker's holdings (offer items) and taker's holdings (consideration items) via direct contract calls (`ownerOf` for ERC-721, `balanceOf` for ERC-1155/ERC-20, `provider.getBalance` for native ETH). Missing assets are flagged per-item, and the Accept button is disabled if either side is missing assets.
- **Offers page**: Checks maker holdings for all open offers on a conservative tri-state basis. Exact native/ERC-20/ERC-721/ERC-1155 items can be confirmed directly. Wildcard ERC-721 criteria items with `identifierOrCriteria == 0` are checked by collection `balanceOf`, including multiple wildcard items from the same contract. ERC-1155 criteria items and non-wildcard criteria proofs cannot be generically verified on the browse page, so those offers remain `unknown` rather than being treated as invalid. In the "Open" view, only orders with confirmed missing maker assets are sorted to the bottom and visually dimmed; unknown availability remains displayed as fillable.
- **Error priority**: Wrong-taker errors take precedence over holdings errors, which take precedence over the Accept button.

Friendly error messages map known custom errors to human-readable messages. The frontend decodes all OTCRegistry custom errors, including structured context for diagnostics such as `OnlySeaport(caller)`, `UnauthorizedTaker(fulfiller, allowedTaker)`, `AlreadyRegistered(orderHash, maker)`, `OrderNotRegistered(orderHash, offerer)`, `WrongZone(provided, expected)`, `WrongOrderType(provided, expected)`, `InvalidConduitKey(conduitKey)`, tip authorization failures, and `MissingItemAmount(itemType, token, identifier)`. It also decodes common Seaport order-state, signature, criteria-resolution, native-value, conduit, and token-transfer errors so the fill/cancel flows can show specific failures instead of a generic transaction error.

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
   b. Check offered assets — verifies exact maker-offered assets are still held and Seaport approvals are visible onchain; maker-side criteria items are approval-checked only because ownership depends on the token ID selected at fulfillment.
   c. Sign Seaport order — EIP-712 signature authorizing settlement (**no gas**)
   d. Sign OTCRegistry registration — EIP-712 signature binding the Seaport-derived `orderHash`, `seaportSignature`, and memo to the maker (**no gas**). The registration expires with the Seaport order's `endTime`. Separate from (c) because the Seaport signature authorizes fund transfer; this one authorizes the public listing and is what sponsored-gas relayers submit.
   e. Register order — `registerOrder` on OTCRegistry (gas, cheap)
8. Success screen shows shareable link
9. User copies link and sends to counterparty

### Accepting a Trade

1. Counterparty opens the shared link
2. UI fetches `OrderRegistered` event from the registration tx receipt and extracts the validated order parameters
3. UI validates: checks Seaport for order status, checks expiration, and reconstructs the Seaport order from the registry event with `signature: "0x"`. The order hash's Seaport validation status plus the registry event are the trust anchors.
4. UI displays all assets with verification indicators
5. UI checks onchain holdings for both maker (offer) and taker (consideration), flagging any missing assets
   - For criteria items, the offer page first asks the fulfiller to choose the concrete token ID(s), then uses those token IDs for holdings checks, approval checks, verification warnings, and criteria resolver calldata.
6. Counterparty reviews the trade
7. Connects wallet
8. Clicks "Accept Trade"
9. UI checks NFTs the taker is receiving for verification status. If any are unverified, a modal warns the user and lists unverified assets with OpenSea links. User must confirm or cancel.
10. UI shows a step-by-step checklist: one step per token approval, an optional cash-tip authorization signature, a fillability simulation step, plus the final fulfillment action. Each step shows status (pending → checking/signing/confirming → done/failed).
11. UI walks through approval steps, asks for a gasless `TipAuthorization` signature only if the fulfiller opted into a tip, simulates the exact Seaport fill from the connected wallet, then calls `fulfillOrder` for no-tip exact-item orders or `fulfillAdvancedOrder` for criteria/tipped orders — one transaction, atomic trade
12. Assets are exchanged

### Cancelling a Trade

1. Maker opens the trade link (or navigates from the offers page)
2. Clicks "Cancel"
3. UI calls `seaport.cancel([orderComponents])` — one onchain tx
4. Order is cancelled onchain

---

## 8. Deployments

Current OTCRegistry deployments and frontend constants are mirrored from
`src/lib/constants.js`. Production deployments are verified on each chain's
block explorer. Sepolia is a testnet deployment for development and is not part
of the V1 production chain scope.

| Chain | Address | Deploy block | Whitelisted ERC-20s |
|---|---|---:|---|
| Ethereum | `0x07C0000007b4B558e2fCd47F47A573413B0Caf7C` | 25125826 | WETH, USDC, USDT, USDS, EURC |
| Sepolia (testnet) | `0xfc9E05BF732FB5Aeee7e270928F349Ed3FA3cc0D` | 10876408 | WETH, USDC |
| Base | `0x07C00000057b66A84004adD3B0f9164E744354CB` | 46185560 | WETH, USDC, USDS, EURC |
| Polygon | `0x07C000000e10b73C0506f36BA75E50a5D3147061` | 87095296 | WETH, USDC, USDT0 |
| Ink | `0x07C00000025CF03243E6fde1BE86af60D12fbF8f` | 45663169 | WETH, USDC, USDT0 |

Deprecated addresses from the previous deployment set are retained only for
historical reference and should not be used for new offers:

| Chain | Deprecated address |
|---|---|
| Ethereum | `0x07C0000003f04E1b0b040A5B6c8AAB792d9546fc` |
| Base | `0x07C00000090AdB1D14b093C1A6b40135779af27C` |
| Polygon | `0x07C000000b63fEe6aC08B91ad7aD3d999b28d740` |
| Ink | `0x07C00000042fFF5Ad7cDC3A2aF3F4A8708B8CD52` |

Historical audit findings, dispositions, and redeploy notes are tracked in
`AUDIT-HISTORY.md`. This spec describes the current intended system only.

---

## 9. Future Roadmap

### Taker Refusal
- Allow the designated taker of a directed offer to refuse it, marking it as unfillable and removing it from open offers.
- Requires a new OTCRegistry function (`refuseOrder`) that stores a `refused[orderHash]` mapping, checked in `validateOrder`.
- Taker verification: either store the taker address at registration time (adds storage cost) or require the caller to pass order parameters so the zone can re-derive the taker from `zoneHash`.
- Only meaningful for directed offers — open offers have no specific taker to refuse.
- Requires OTCRegistry redeployment on all chains (contract is immutable). Bundle with other contract changes to avoid redundant redeploys.

### V2 - Solana Support
- Separate program, shared UI
- Not related to Seaport

### Client-Side Event Cache
- Cache `OrderRegistered` events in IndexedDB, keyed by zone contract address. Store a block-number watermark; on return visits, only query from the watermark forward.
- Reduces RPC/Alchemy calls from O(full history) to O(blocks since last visit) for repeat visitors. First-time visitors still pay the full scan.
- Best implemented once the contract address is stable (no more redeployments) and the offers page has been migrated to Alchemy or another indexed RPC. Stale zone addresses are naturally orphaned when the address changes.
- Does not help first-time or incognito visitors. Not a substitute for proper indexing at scale, but buys significant headroom on API rate limits.

### ERC-7730 Clear-Signing Metadata
- After the next OTCRegistry redeploy, publish ERC-7730 descriptors for Ocarina-owned signing surfaces so supported wallets can show human-readable signing prompts.
- Primary targets: `registerOrder(OrderRegistration)` calldata ("Publish Ocarina offer"), the OTCRegistry EIP-712 registration signature ("Authorize Ocarina offer publication"), and the optional `TipAuthorization` EIP-712 signature ("Authorize Ocarina tip").
- Include descriptor tests with sample transactions / typed data, then submit to the Ethereum ERC-7730 registry: `https://github.com/ethereum/clear-signing-erc7730-registry`.
- Do not try to own generic Seaport signing metadata. Seaport order signatures and `fulfillOrder` calldata target the canonical Seaport contract, so Ocarina-specific rendering there depends on wallet support for contextual constraints such as `zone == OTCRegistry`.

### Marketplace Memo Attestations
- Define an optional memo-attestation convention for marketplaces that want to create and fulfill OTCRegistry offers through their own UI, while filtering their UI to only show offers created through their marketplace.
- No contract change is required: `memo` is emitted in `OrderRegistered` and already bound by the maker's OTCRegistry registration signature via `keccak256(bytes(memo))`.
- Suggested memo envelope: `ocsig:v1:<marketplaceId>:<keyId>:<signature>`, where the signature is a compact ECDSA/EIP-2098 or equivalent short signature. Budget roughly 140 bytes for the machine attestation and 140 bytes for optional user memo text under the current 280-byte cap. Marketplaces that do not expose a user memo can use the full memo space for their envelope.
- Suggested signed payload: `chainId`, OTCRegistry address, `orderHash`, maker, `marketplaceId`, and `keyId`. `chainId`, registry, `orderHash`, and maker are derived from the event / page context; only `marketplaceId`, `keyId`, and the signature need to appear in the memo.
- Do not include a constraints hash by default. Marketplace filtering and moderation should inspect the decoded offer data directly; the attestation only means "created through this marketplace UI", not "settlement-enforced by this marketplace".
- General UIs such as Ocarina should detect recognized machine-attestation envelopes and hide them from user-facing memo display. If a memo contains both user text and an attestation, display only the user text.

### Privy Cross-App Wallet Support
- Platforms like Courtyard.io (Polygon) and Beezie (Base) use Privy embedded wallets. Their users can't currently connect to external dApps like ours.
- Privy's `@privy-io/cross-app-connect` SDK exposes `toPrivyWalletProvider()`, which returns a standard EIP-1193 provider — compatible with ethers.js, no wagmi/viem required at runtime.
- **Blocker**: Each provider app must enable cross-app sharing in their Privy dashboard. As of 2026-03-20, neither Courtyard nor Beezie has enabled this.
  - Courtyard Privy app ID: `cldj2z0b70001mm08l39me9k5`
  - Beezie Privy app ID: `clozdtqzz0070l80gtizlvizg`
- No code changes needed on our end until a provider enables sharing. Integration is ~50 lines: create an EIP-1193 provider with `toPrivyWalletProvider({ providerAppId, chains })`, wrap in `ethers.BrowserProvider`, and use the signer as normal.
- Privy was acquired by Stripe in mid-2025 — watch for API changes.

### Farcaster / Base App Mini-Apps
- The site's architecture (no backend, path-based client routing with SPA fallback, standard EIP-1193 wallet interface) is compatible with mini-app embedding.
- Main work: detect mini-app context and replace the wallet provider (Farcaster SDK or Coinbase Wallet SDK instead of Reown AppKit). Everything downstream (ethers.js, Seaport calls) stays the same.
- Requires a separate OTCRegistry deployment per chain (already done for Base, Polygon, and Ink).

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
- OTCRegistry contract address per chain
- OTCRegistry deploy block per chain (for efficient event queries)
- ERC-20 whitelist addresses per chain
- RPC endpoint URLs per chain
- IPFS gateway URL

Alchemy-specific config lives in `src/lib/alchemy.js` and `src/lib/metadata.js`:
- Alchemy API key (via `VITE_ALCHEMY_API_KEY` env var)
- Alchemy network identifiers per chain (`ALCHEMY_NETWORKS`)

### External Services
- **Reown AppKit**: Wallet connection (requires project ID via `VITE_REOWN_PROJECT_ID`)
- **Alchemy NFT v3 API**: Collection enumeration (`getContractsForOwner`, includes `isSpam` flag for spam detection) and per-collection NFT fetching (`getNFTsForOwner`) for the wallet picker on Alchemy-backed chains, plus single-NFT metadata fallback (`getNFTMetadata`) on the trade page (requires API key via `VITE_ALCHEMY_API_KEY`). The app remains functional without it — manual asset entry is always available, and Blockscout-backed chains can still enumerate wallet NFTs.
- **Blockscout APIs**: Account transaction API for `OrderRegistered` discovery, logs API for filled-order transaction lookup, and v2 NFT endpoints for wallet holdings on chains without Alchemy NFT API support.
- **Blockchain data**: Public RPC endpoints for receipts, order status, counters, holdings, approvals, metadata fallback calls, and partial event discovery when Blockscout is unavailable.
- **NFT metadata fallback**: On-chain tokenURI + public IPFS gateways
- **Hosting**: Any static file host
- **Verified token list**: Bundled static JSON file, supplemented by Alchemy's OpenSea safelist status for runtime verification of unlisted contracts

---

## 11. Dependencies (Exhaustive List)

### Runtime
- **ethers** (v6): Contract interaction, ABI encoding
- **@opensea/seaport-js**: Order construction, EIP-712 signing, hash computation, and cancellation helpers
- **react** + **react-dom** (v19): UI rendering
- **react-router** (v7): Path-based client routing via `createBrowserRouter`
- **@reown/appkit** + **@reown/appkit-adapter-ethers**: Wallet connection
- **buffer**: Node.js Buffer polyfill (required by seaport-js in the browser)

### Contract
- **solady**: Signature verification (`SignatureCheckerLib` — EOA + EIP-1271 + EIP-2098 compact)
- **seaport-types**: Seaport interface types (`ZoneInterface`, structs, enums)

### Dev
- **vite**: Build tool
- **@vitejs/plugin-react**: JSX transform
- **foundry** (forge): OTCRegistry contract development and testing

The only custom contract is OTCRegistry, deployed once per chain. Foundry is needed only for this contract.

---

## 12. Open Questions

1. ~~**URL length**~~: **Resolved** — URLs use the `/offer/{chainId}/{txHash}` format. The validated order parameters are stored onchain in the `OrderRegistered` event and fetched via tx receipt.

2. ~~**Offers page without events**~~: **Resolved** — the OTCRegistry contract emits `OrderRegistered` events, providing an onchain index of published orders. The offers page queries these events and cross-references with Seaport for order status.

3. ~~**OTCRegistry implementation**~~: **Resolved** — implemented and tested. The Seaport 1.6 `ZoneInterface` requires `authorizeOrder`, `validateOrder`, `getSeaportMetadata`, and `supportsInterface`. Our contract implements all four. See `contracts/src/OTCRegistry.sol` and `contracts/test/OTCRegistry.t.sol`.

4. ~~**Maker approvals timing**~~: **Resolved** — prompt approvals at order creation. The maker pays gas for approvals, but the order is immediately fillable. This avoids confusion where a taker opens a link and can't fill because the maker forgot to approve.
