# ocarina.trade — System Interaction Flows

## Create Order

```mermaid
sequenceDiagram
    participant F as Frontend
    participant W as Wallet
    participant S as Seaport
    participant Z as OTCRegistry

    F->>F: Build order params from exact assets and optional Any Token criteria items
    Note over F: Any Token uses ERC721_WITH_CRITERIA / ERC1155_WITH_CRITERIA<br/>with identifierOrCriteria = 0 (wildcard)
    F->>F: Encode zoneHash: taker in low 160 bits,<br/>original consideration count + version in upper bits

    F->>W: setApprovalForAll(seaport, true)
    W->>S: Approval tx (per collection)
    S-->>F: Confirmed

    F->>F: Check offered exact assets are still held
    F->>F: Check Seaport approvals are visible onchain
    Note over F: Maker-side criteria items are approval-checked only;<br/>ownership depends on token ID chosen at fulfillment

    F->>W: EIP-712 sign Seaport order (no gas)
    W-->>F: Signed Seaport order { parameters, signature }

    F->>F: Compute orderHash (local, via seaport-js)

    F->>W: EIP-712 sign OTCRegistry registration (no gas)
    Note over F,W: domain: {name: "OTCRegistry", version: "1", chainId, zone}<br/>struct: {orderHash, seaportSignature, memo}
    W-->>F: Registration signature

    F->>W: registerOrder(reg)
    W->>Z: registerOrder tx (submitter can be maker or a relayer)
    Z->>Z: Check memo length ≤ 280
    Z->>Z: Check startTime <= block.timestamp <= endTime
    Z->>Z: Assert zone == address(this)
    Z->>Z: Assert orderType == FULL_RESTRICTED
    Z->>Z: Assert conduitKey == bytes32(0)
    Z->>Z: Require valid zoneHash metadata
    Note over Z: version == 1, reserved bits == 0,<br/>originalConsiderationCount == components.consideration.length
    Z->>S: getCounter(offerer)
    S-->>Z: Current maker counter
    Z->>Z: Require components.counter == current counter
    Z->>Z: Validate item shape, recipients, native side, ERC-20 whitelist, and ERC-165
    Note over Z: ERC-721 criteria items must have amount 1;<br/>multiple Any ERC-721s are separate criteria items
    Note over Z: ERC-165 validation also probes 0xffffffff<br/>to reject permissive responders
    Z->>Z: orderHash = ISeaport.getOrderHash(components) (delegates to Seaport)
    Z->>Z: Check !registered[orderHash]
    Note over Z: registered is both duplicate-publication guard<br/>and settlement allowlist
    Z->>Z: registered[orderHash] = true (CEI before signature check)
    Z->>Z: Verify registration signature (ECDSA or EIP-1271) against OTCRegistry domain
    Z->>S: validate([{ parameters, seaportSignature }])
    S-->>Z: true or revert
    Z->>Z: taker = address(uint160(zoneHash))
    Z->>Z: emit OrderRegistered(orderHash, maker, taker, components, memo)
    Z-->>F: Tx receipt

    F->>F: Navigate to /offer/{chainId}/{txHash}
```

## View Trade (Load from URL)

```mermaid
sequenceDiagram
    participant F as Frontend
    participant R as RPC
    participant S as Seaport

    F->>R: getTransactionReceipt(txHash)
    R-->>F: Receipt with OrderRegistered event

    F->>F: Require log.address == canonical OTCRegistry for chainId
    F->>F: Parse event → orderHash, maker, taker, components, memo
    F->>F: Recheck registry zone, FULL_RESTRICTED orderType, and derived orderHash
    F->>F: Reconstruct OrderWithCounter from components + signature 0x

    F->>S: getOrderStatus(orderHash)
    S-->>F: { isCancelled, totalFilled, totalSize }

    F->>S: getCounter(offerer)
    S-->>F: Current maker counter

    F->>F: Derive status (open / filled / cancelled / expired)
    Note over F: Counter > order.counter means bulk-cancelled
    F->>F: If criteria items exist, wait for fulfiller token ID selections
    F->>F: Display trade details
```

## Accept (Fill) Order

```mermaid
sequenceDiagram
    participant F as Frontend
    participant W as Wallet
    participant S as Seaport
    participant Z as OTCRegistry

    alt Order contains criteria items
        F->>F: Ask fulfiller for concrete token ID per criteria item
        F->>F: Reject missing selections
        F->>F: Reject duplicate ERC-721 token IDs for same contract
        F->>F: Use selected token IDs for holdings / verification checks
    end

    opt Optional cash tip enabled by a frontend
        F->>F: Append native / whitelisted ERC-20 tip consideration items
        F->>W: EIP-712 sign TipAuthorization (no gas)
        Note over F,W: Covers orderHash, fulfiller, TipItem[] tips, deadline
        W-->>F: Tip authorization signature
        F->>F: ABI-encode (deadline, signature) as advancedOrder.extraData
    end

    F->>W: setApprovalForAll(seaport, true)
    W->>S: Approval tx (per collection)
    S-->>F: Confirmed

    alt Exact-item no-tip order
        F->>S: fulfillOrder.staticCall(order, bytes32(0))
    else Criteria order or tipped order
        F->>S: fulfillAdvancedOrder.staticCall(advancedOrder, criteriaResolvers, bytes32(0), address(0))
    end
    S-->>F: Simulation succeeds or reverts before final tx

    alt Exact-item no-tip order
        F->>W: fulfillOrder(order, bytes32(0))
        W->>S: fulfillOrder tx
    else Criteria order or tipped order
        F->>W: fulfillAdvancedOrder(advancedOrder, criteriaResolvers, bytes32(0), address(0))
        W->>S: fulfillAdvancedOrder tx
    end

    S->>Z: authorizeOrder(zoneParameters)
    Z->>Z: Require msg.sender == seaport
    Z->>Z: Check zoneHash → taker restriction (pre-transfer)
    Z-->>S: selector

    S->>S: Transfer assets atomically
    Note over S: maker→taker (offer)
    Note over S: taker→maker (consideration)

    S->>Z: validateOrder(zoneParameters)
    Z->>Z: Require msg.sender == seaport
    Z->>Z: Require registered[orderHash]
    Z->>Z: Recheck ERC-20 whitelist
    Z->>Z: Decode original consideration count from zoneHash
    alt Extra consideration items are present
        Z->>Z: Treat extras as tips
        Z->>Z: Require native or whitelisted ERC-20 tips only
        Z->>Z: Verify TipAuthorization from fulfiller
    else No extra consideration items
        Z->>Z: Require extraData is empty
    end
    Z-->>S: selector (valid)

    S->>S: emit OrderFulfilled(orderHash, ...)
    S-->>F: Tx receipt

    F->>F: Update status → filled
```

## Cancel Order

```mermaid
sequenceDiagram
    participant F as Frontend
    participant W as Wallet
    participant S as Seaport

    F->>W: cancel([orderComponents])
    W->>S: cancel tx

    S->>S: Mark order cancelled
    S->>S: emit OrderCancelled(orderHash, ...)
    S-->>F: Tx receipt

    F->>F: Update status → cancelled
```

## Browse Offers

```mermaid
sequenceDiagram
    participant F as Frontend
    participant Z as OTCRegistry
    participant S as Seaport

    F->>Z: Blockscout account txlist for OTCRegistry
    Note over F,Z: Primary path: fetch registerOrder tx receipts<br/>and parse OrderRegistered logs
    Z-->>F: OrderRegistered events

    alt Blockscout unavailable
        F->>Z: eth_getLogs fallback
        Note over F,Z: Chunked recent scan from deploy block / lookback window
        Z-->>F: OrderRegistered events
    end

    F->>F: Dedupe by orderHash, earliest registration wins

    loop For each order
        F->>S: getOrderStatus(orderHash)
        S-->>F: { isCancelled, totalFilled, totalSize }
    end

    loop For each unique maker
        F->>S: getCounter(maker)
        S-->>F: Current maker counter
    end

    F->>F: Derive status per order
    Note over F: Exclude filled, cancelled, expired,<br/>and counter-invalidated orders from Open
    F->>F: Filter by status tab (Open / All)
    F->>F: Render criteria NFTs as Any token without metadata lookup
    F->>F: Display offer cards
```
