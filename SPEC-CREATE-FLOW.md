# Create Offer Flow Redesign

## Motivation

The current Create Offer page is a single complex form that asks for everything at once: asset types, contract addresses, token IDs, amounts, taker address, and expiration. This is overwhelming, especially for users who aren't deep in crypto jargon.

In practice, most users arriving at the homepage have already negotiated a trade with someone specific on Discord, Twitter, or another channel. They know who they're trading with and roughly what they're trading. The site's job is to formalize that agreement into an onchain order as painlessly as possible.

Users *accepting* an offer mostly arrive via a direct link — they rarely browse the homepage.

### Design principles

- **Low commitment first.** Collect the taker address before asking the user to connect a wallet. Wallet connection is a common churn point — delay it until necessary.
- **One decision per screen.** Break the flow into discrete steps so each screen has a single clear purpose.
- **No jargon.** Replace "ERC-721", "ERC-1155", "ERC-20" with "collectibles" and "cash". Users don't think in token standards.
- **Show, don't ask.** Enumerate the user's actual holdings instead of asking them to type contract addresses. Fall back to manual entry when needed.
- **Progressive disclosure.** Defaults handle the common case (30-day expiration, directed offer). Advanced options exist but don't clutter the main flow.

---

## Flow Overview

```
Homepage          Who are you trading with?
    |                 [Enter address or ENS]
    |                 or "Make an open offer"
    v
Connect Wallet    Connect your wallet to continue
    |                 (auto-skipped if already connected)
    v
Select Chain      Which chain are you trading on?
    |                 Ethereum / Base / Polygon
    v
Your Offer        What are you offering?
    |                 [Collectibles grid] [Cash list]
    v
Their Side        What do you want in return?
    |                 [Their holdings or manual entry]
    v
Review            Summary of both sides
    |                 + expiration (default 30 days)
    |                 + optional memo
    |                 [Confirm]
    v
Execute           Approvals + signature + registration
    |                 Step-by-step checklist
    v
Done              Success! Copy the link.
```

---

## Screen-by-Screen Specification

### 1. Homepage — "Who are you trading with?"

**Purpose:** Collect the counterparty address before anything else.

**Layout:**
- A prominent label "Who are you trading with?" styled as a page title
- A text input: "Wallet address or ENS name" styled with dark background and rounded corners
  - Validates as a valid Ethereum address or resolves via ENS
  - "Start" button is dim until a valid address or ENS name is detected, then lights up as a primary (blue) button
  - On submit, stores the taker address and navigates to the Create wizard
- Below the input, a secondary link: "Or make an open offer anyone can accept"
  - Navigates to Create with taker set to `null`
- "Browse Offers" button (secondary style) below that
- No wallet connection UI on this screen — the AppKit button is hidden on the homepage

**Behavior:**
- ENS names resolve via mainnet provider (existing `resolveENSName` function)
- Invalid input shows inline error: "Enter a valid Ethereum address or ENS name." Failed ENS resolution shows: "Could not resolve ENS name."
- If the user is already connected (e.g., returning to homepage), still show this screen — the taker address is the primary input here

### 2. Connect Wallet

**Purpose:** Get the user's wallet connected.

**Layout:**
- Brief context: "Connect your wallet to continue"
- If taker was specified, show it: "Trading with: `vitalik.eth` (0x1234...5678)"
- Reown AppKit connect button (existing component)
- Once connected, auto-advance to chain selection

**Behavior:**
- If the wallet is already connected (e.g., returning user, or mobile wallet browser with injected provider), skip this screen automatically
- Show the connected address once connected, with a brief pause (~1s) before advancing so the user sees confirmation

### 3. Select Chain

**Purpose:** Choose which chain the trade happens on.

**Layout:**
- Three large buttons/cards, one per chain:
  - **Ethereum** — "OG NFTs, CryptoPunks, Art Blocks, etc."
  - **Base** — "Beezie, Slab, and other collectibles"
  - **Polygon** — "Courtyard collectibles"
- Chain icons or color accents could be added in the future but are not currently implemented

**Behavior:**
- Selecting a chain triggers a wallet network switch via AppKit's `switchNetwork` (requires AppKit network objects from `@reown/appkit/networks`, not plain `{ chainId }`)
- Wait for the chain switch to confirm before advancing
- If chain switch is rejected by the user, stay on this screen
- If the wallet is already on a supported chain, that chain is pre-highlighted but the user can still pick a different one
- Changing chain clears any previously selected assets (both maker and taker)

**Edge case:** If the user's wallet is on an unsupported chain (e.g., Arbitrum), no chain is pre-selected.

### 4. Your Offer — "What are you offering?"

**Purpose:** Select assets from the maker's wallet to include in the offer.

**Layout:**
- Two sections, toggled by tabs or a segmented control:
  - **Collectibles** — grid of NFT collections from the connected wallet (fetched via Alchemy NFT v3 API `getContractsForOwner`)
  - **Cash** — list of whitelisted ERC-20 tokens for the selected chain

**Collectibles tab:**
- Collections fetched directly via `getContractsForOwner`, displayed as a grid with collection name, image, and token count. Clicking a collection drills into its individual NFTs; clicking "Back to collections" returns to the collection list.
- When drilling into a collection, the individual NFTs are fetched via `fetchNFTsForContract` (which uses `getNFTsForOwner` filtered to that contract) so all tokens are visible.
- Tapping a card selects/deselects it (visual toggle — checkmark overlay or border highlight)
- For ERC-1155 tokens with balance > 1, show a quantity selector after selection
- If Alchemy fails or returns no NFTs, show a message with a fallback: "Don't see your NFT? Add it manually" → expands a manual entry form (contract address + token ID). Manual entry includes a link to the address's OpenSea profile.
- "Add NFT manually" link always visible at the bottom of the grid, even when Alchemy works (in case an NFT wasn't indexed)
- Search/filter bar at the top of the grid (filter by collection name or token name)
- Verified collections (OpenSea `verified`/`approved`) show a blue checkmark badge
- Spam collections hidden behind a "Show Potential Spam (#)" toggle (see SPEC-SEAPORT.md §5 for spam detection details)
- Auto-fetches pages via `getContractsForOwner` until 50 non-spam collections are loaded; "Load More Collections" button for additional pages
- Initial load sorts verified collections to the top; subsequent Load More appends at the bottom

**Cash tab:**
- List of whitelisted ERC-20 tokens for the selected chain
- Each row shows: token icon (if available), symbol, current wallet balance
- Tokens with zero balance are greyed out and disabled (the maker cannot offer tokens they don't hold)
- Tapping a token opens/expands an amount input field
- Native ETH is NOT shown here (taker-side only per Seaport constraint)

**Running tally (sticky footer):**
- Always visible at the bottom of the screen
- Summarizes selected assets in natural language: "2 Milady Maker, 1 Pudgy Penguin, and 12.34 USDC"
  - Collectibles grouped by collection name with count
  - Cash shown as amount + symbol
- "Next" button (disabled until at least one asset is selected)

**Behavior:**
- Selections persist if the user navigates back and forth between tabs
- Navigating back to the chain select screen and selecting a different chain silently clears all asset selections (acceptable since the user must explicitly navigate back and re-select)

### 5. Their Side — "What do you want in return?"

**Purpose:** Specify what the taker should give in exchange.

This screen varies based on whether a taker address was specified.

#### 5a. Directed offer (taker address known)

**Layout:**
- Header: "What do you want in return?" (same for directed and open offers)
- Subtitle: "From `vitalik.eth`" (or truncated address) with × button to remove taker (make open) and "Change" link → inline address/ENS input with Save/Cancel
- Same two-tab layout as "Your Offer" screen (Collectibles / Cash), but populated from the **taker's** wallet holdings
- Same selection mechanics (tap to select, quantity for ERC-1155, amount input for cash)
- Same "Add NFT manually" fallback
- Same running tally footer with "Next" button
- Cash tab shows all whitelisted tokens with taker balances displayed. All tokens are enabled (not greyed out) — the taker may acquire tokens before accepting.
- Additionally, native ETH is available as a consideration item in the cash list

#### 5b. Open offer (no taker address)

**Layout:**
- Header: "What do you want in return?" with subtitle "From Anyone" and "Change" link → inline address/ENS input with Save/Cancel
- Same two-tab layout (Collectibles / Cash), but since we can't enumerate a stranger's holdings:
  - **Cash tab** — whitelisted ERC-20 tokens + native ETH, with amount inputs (no balance display since taker is unknown). All tokens are enabled (not greyed out).
  - **Collectibles tab** — manual entry only (no collection browsing). Shows message "Add collectibles by contract address and token ID" with always-visible manual add form: contract address + token ID + type toggle (ERC-721 / ERC-1155) + amount (for ERC-1155)
  - When a collectible is added manually, attempt to fetch its metadata for display (existing `fetchMetadata` function)
- Same running tally footer with "Next" button

### 6. Review — "Review your offer"

**Purpose:** Final review of all details before signing.

**Layout:**
- Two-column (or stacked on mobile) summary:
  - **You're offering:** list of selected maker assets with thumbnails/amounts
  - **You're receiving:** list of selected taker assets with thumbnails/amounts
- Maker address (connected wallet) with ENS name if available
- Taker: address/ENS or "Anyone"
- **Expiration:** defaults to "30 days from now" (shown as a human-readable date). A "Change" link opens a date/time picker or preset buttons (7 days, 14 days, 30 days, 90 days, custom).
- Optional memo field (always visible). 280-byte limit with live character count. Warning displayed above the textarea: "This memo will be posted publicly onchain and cannot be deleted. Do not include sensitive information."
- Large "Confirm" button

**Behavior:**
- All fields are read-only summaries; editing requires going back to the relevant step
- "Back" button returns to the consideration screen
- "Confirm" advances to the execution screen

### 7. Execute — "Submitting your offer"

**Purpose:** Walk through all required signatures and transactions.

**Layout:**
- A one-line tally summary at the top: "Offering: [assets] for [assets]"
- Below, a step-by-step checklist (reuse existing `TxChecklist` component):
  1. Approval steps — one per unique token contract that needs approval (ERC-721/ERC-1155: `setApprovalForAll`, ERC-20: `approve` with exact amount)
  2. Sign order — EIP-712 signature (no gas)
  3. Register order — `registerOrder` transaction on OTCZone
- Each step shows status: pending → signing/confirming → done → failed
- Steps execute sequentially; the user confirms each wallet prompt

**Behavior:**
- Before starting, check if the wallet's current chain matches the selected chain. If mismatched, show: "Your wallet is on the wrong network. Please switch to {chain name} to continue." Execution auto-starts once the wallet switches to the correct chain.
- Steps execute sequentially; the user confirms each wallet prompt
- If any step fails, show the error inline with a "Retry" option and a "Back to Review" link to return to the previous screen

### 8. Done — "Your offer is live!"

**Purpose:** Celebrate and provide the shareable link.

**Layout:**
- Success checkmark and "Your offer is live!" message
- The offer link, prominently displayed: `https://ocarina.trade/#/trade/{chainId}/{txHash}`
- "Copy Link" button (copies to clipboard, shows "Copied!" confirmation)
- "View your offer" link (navigates to the trade page)
- "Create another offer" link (returns to homepage)
- Step indicator shows all dots as completed (green) via `allComplete` prop

---

## State Management

The wizard needs to maintain state across multiple screens. Options:

**Recommended: React state in a parent component/context**
- A `CreateFlowProvider` context wraps all wizard screens
- State shape:
  ```js
  {
    taker: string | null,       // address or null for open offers
    takerENS: string | null,    // resolved ENS name for display
    chainId: number | null,
    makerAssets: Asset[],       // selected offer items
    takerAssets: Asset[],       // selected consideration items
    expiration: number | null,  // unix timestamp, default 30 days
    memo: string,
  }
  ```
- Each screen reads from and writes to this context
- Navigating back preserves state; navigating forward validates the current step
- State also tracks `currentStep` (index into the step list)

**Step indicator:**
- A compact row of labeled dots across the top of every wizard screen (rendered by the `WizardShell`):
  ```
  Connect · Chain · You Offer · You Want · Review · Submit
  ```
- Current step is highlighted (blue); completed steps are filled (green); future steps are dimmed
- Completed steps are clickable to jump back (state is preserved)
- Future steps are not clickable
- On the Done screen, all steps show as completed (all green) via the `allComplete` prop on `WizardShell`
- On mobile, labels collapse to dots only (with the current step label shown below)

**Unsaved changes warning:**
- Once the user has selected any maker assets (step 4 onward), navigating away from the wizard (clicking a nav link, closing the tab, or using browser back to leave `#/create`) should trigger a confirmation dialog: "Are you sure you want to leave? Your offer hasn't been submitted and all changes will be lost."
- Use the `beforeunload` event for tab close/refresh, and in-app navigation guards for route changes.
- Steps before asset selection (homepage, connect wallet, chain select) do not need this warning — nothing meaningful has been entered yet.

**Routing:**
- The wizard screens could be:
  - Separate routes under `#/create/*` (e.g., `#/create/connect`, `#/create/chain`, `#/create/offer`, etc.)
  - Or a single `#/create` route with internal step state
- Recommendation: single `#/create` route with step state. Avoids URL complexity, and the wizard steps aren't independently meaningful URLs. The taker address from the homepage can be passed via navigation state or a query param.

**Homepage integration:**
- The homepage taker input navigates to `#/create` with the taker address in route state
- The "open offer" link navigates to `#/create` with taker explicitly set to `null`

---

## Implementation

The wizard is fully implemented. Key files:

- `src/pages/create.jsx` — Route component, wraps wizard in `CreateFlowProvider` and `WizardShell`
- `src/pages/home.jsx` — Homepage with taker address input
- `src/components/create-flow/context.jsx` — `CreateFlowProvider` context + state + navigation
- `src/components/create-flow/wizard-shell.jsx` — Step indicator + `beforeunload` warning
- `src/components/create-flow/step-connect.jsx` — Wallet connection screen
- `src/components/create-flow/step-chain.jsx` — Chain selection with wallet network switching
- `src/components/create-flow/step-offer.jsx` — Maker asset selection
- `src/components/create-flow/step-want.jsx` — Taker asset selection (with inline taker address editing)
- `src/components/create-flow/step-review.jsx` — Review summary with expiration presets + memo
- `src/components/create-flow/step-execute.jsx` — Approval + sign + register checklist
- `src/components/create-flow/step-done.jsx` — Success screen with shareable link
- `src/components/create-flow/asset-picker.jsx` — Combined collectibles grid + cash list, used for both sides
- `src/components/create-flow/asset-tally.jsx` — Running tally of selected assets

Reused from prior implementation:
- `TxChecklist` component (step-by-step approval/sign/register display)
- `AssetCard` component (asset display with verification)
- ENS resolution functions (`resolveENS`, `resolveENSName`)
- `createOrder` and approval logic from `contract.js`
- `AddressDisplay` component (address with ENS reverse resolution)

---

## Resolved Design Decisions

1. **Homepage offers display.** Homepage is purely the "start a trade" entry point for V1. Offers page handles browsing. Homepage design beyond the taker input is out of scope for this spec.
2. **ERC-1155 fungible tokens.** Shown as collectibles with quantity selectors. Users with these assets are crypto-native enough to find them there.
3. **Mobile wallet browsers.** Auto-detect injected provider and skip the Connect Wallet screen.
4. **Bookmarking mid-flow.** Refreshing loses wizard progress. Acceptable for V1 — the unsaved changes warning on `beforeunload` mitigates accidental loss.
5. **Social share links.** Omitted. Most offers are directed to a specific person, so public sharing prompts feel spammy. Users can copy/paste the link themselves.
