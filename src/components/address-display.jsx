import { useState, useEffect } from 'react'
import { resolveENS } from '../lib/ens'
import { getEtherscanUrl } from '../lib/verification'

export default function AddressDisplay({ address, chainId, showFull = false }) {
  const [ensName, setEnsName] = useState(null)

  useEffect(() => {
    if (!address) return
    let cancelled = false
    resolveENS(address).then((name) => {
      if (!cancelled) setEnsName(name)
    })
    return () => { cancelled = true }
  }, [address])

  const etherscanUrl = getEtherscanUrl(chainId, address)
  const truncated = address.slice(0, 6) + '...' + address.slice(-4)

  return (
    <a
      className="address-display"
      href={etherscanUrl}
      target="_blank"
      rel="noopener noreferrer"
      title={address}
    >
      {ensName ? (
        <span className="ens-name">{ensName}</span>
      ) : (
        <code>{showFull ? address : truncated}</code>
      )}
    </a>
  )
}
