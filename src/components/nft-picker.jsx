import { useState, useEffect, useCallback } from 'react'
import { fetchWalletNFTs } from '../lib/alchemy'

/**
 * Deduplicate NFTs by contract+tokenId, summing balances.
 */
function dedupeNFTs(nfts) {
  const map = new Map()
  for (const nft of nfts) {
    const key = `${nft.contract.toLowerCase()}-${nft.tokenId}`
    if (map.has(key)) {
      const existing = map.get(key)
      existing.balance = String(BigInt(existing.balance) + BigInt(nft.balance))
    } else {
      map.set(key, { ...nft })
    }
  }
  return Array.from(map.values())
}

export default function NFTPicker({ address, chainId, onSelect, onClose }) {
  const [nfts, setNfts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [pageKey, setPageKey] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [selected, setSelected] = useState(null) // ERC-1155 quantity picker
  const [quantity, setQuantity] = useState('1')

  useEffect(() => {
    if (!address || !chainId) return
    setLoading(true)
    setError(null)
    setNfts([])
    setPageKey(null)
    setSelected(null)

    fetchWalletNFTs(address, chainId)
      .then(({ nfts: fetched, pageKey: nextKey }) => {
        setNfts(dedupeNFTs(fetched))
        setPageKey(nextKey)
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [address, chainId])

  const loadMore = useCallback(async () => {
    if (!pageKey || loadingMore) return
    setLoadingMore(true)
    try {
      const { nfts: more, pageKey: nextKey } = await fetchWalletNFTs(address, chainId, pageKey)
      setNfts((prev) => dedupeNFTs([...prev, ...more]))
      setPageKey(nextKey)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoadingMore(false)
    }
  }, [address, chainId, pageKey, loadingMore])

  const handleClick = useCallback((nft) => {
    if (nft.tokenType === 'ERC1155' && BigInt(nft.balance) > 1n) {
      setSelected(nft)
      setQuantity('1')
    } else {
      onSelect({
        token: nft.contract,
        tokenId: nft.tokenId,
        amount: '1',
        assetType: nft.tokenType === 'ERC1155' ? 'ERC1155' : 'ERC721',
      })
    }
  }, [onSelect])

  const handleConfirmQuantity = useCallback(() => {
    if (!selected) return
    const qty = parseInt(quantity, 10)
    if (!qty || qty < 1 || qty > Number(selected.balance)) return
    onSelect({
      token: selected.contract,
      tokenId: selected.tokenId,
      amount: String(qty),
      assetType: 'ERC1155',
    })
  }, [selected, quantity, onSelect])

  return (
    <div className="nft-picker-overlay" onClick={onClose}>
      <div className="nft-picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="nft-picker-header">
          <h3>{selected ? 'Select Quantity' : 'Select NFT'}</h3>
          <button className="btn-remove" onClick={selected ? () => setSelected(null) : onClose} type="button">&times;</button>
        </div>

        {selected ? (
          <div className="nft-picker-quantity">
            <div className="nft-picker-quantity-preview">
              <div className="nft-picker-image nft-picker-image-sm">
                {selected.image ? (
                  <img src={selected.image} alt={selected.name} />
                ) : (
                  <span className="asset-card-placeholder">?</span>
                )}
              </div>
              <div>
                <div className="nft-picker-name">{selected.name}</div>
                <div className="nft-picker-collection">{selected.contractName || selected.contract.slice(0, 8) + '...'}</div>
              </div>
            </div>
            <div className="nft-picker-quantity-input">
              <label>Quantity (max {selected.balance})</label>
              <input
                type="number"
                min="1"
                max={selected.balance}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
              <button
                className="btn btn-primary btn-sm"
                onClick={handleConfirmQuantity}
                type="button"
              >
                Add
              </button>
            </div>
          </div>
        ) : (
          <>
            {loading && <p className="text-muted nft-picker-status">Loading NFTs...</p>}
            {error && <p className="form-error nft-picker-status">{error}</p>}

            {!loading && !error && nfts.length === 0 && (
              <p className="text-muted nft-picker-status">No NFTs found in this wallet.</p>
            )}

            {nfts.length > 0 && (
              <div className="nft-picker-grid">
                {nfts.map((nft) => (
                  <button
                    key={`${nft.contract}-${nft.tokenId}`}
                    className="nft-picker-item"
                    onClick={() => handleClick(nft)}
                    type="button"
                  >
                    <div className="nft-picker-image">
                      {nft.image ? (
                        <img src={nft.image} alt={nft.name} loading="lazy" />
                      ) : (
                        <span className="asset-card-placeholder">?</span>
                      )}
                    </div>
                    <div className="nft-picker-label">
                      <span className="nft-picker-name">{nft.name}</span>
                      {nft.contractName && <span className="nft-picker-collection">{nft.contractName}</span>}
                      <span className="nft-picker-meta">
                        <span className="nft-picker-id">#{nft.tokenId}</span>
                        {nft.tokenType === 'ERC1155' && BigInt(nft.balance) > 1n && (
                          <span className="nft-picker-balance">x{nft.balance}</span>
                        )}
                      </span>
                      <span className="nft-picker-address">{nft.contract.slice(0, 6)}...{nft.contract.slice(-4)}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {pageKey && !loading && (
              <button
                className="btn btn-secondary btn-sm nft-picker-load-more"
                onClick={loadMore}
                disabled={loadingMore}
                type="button"
              >
                {loadingMore ? 'Loading...' : 'Load More'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
