import { useState, useEffect } from 'react'
import { resolveENS } from '../lib/ens'
import { getEtherscanUrl } from '../lib/verification'

export default function AddressDisplay({ address, chainId, showFull = false, asSpan = false, nameOverride = null }) {
  const [ensName, setEnsName] = useState(nameOverride)
  const [resolved, setResolved] = useState(!!nameOverride)

  useEffect(() => {
    if (!address || nameOverride) return
    let cancelled = false
    setResolved(false)
    resolveENS(address).then((name) => {
      if (!cancelled) {
        setEnsName(name)
        setResolved(true)
      }
    }).catch(() => {
      if (!cancelled) setResolved(true)
    })
    return () => { cancelled = true }
  }, [address, nameOverride])

  const etherscanUrl = getEtherscanUrl(chainId, address)
  const truncated = address.slice(0, 6) + '...' + address.slice(-4)

  const content = !resolved ? (
    <code className="address-loading">{truncated}</code>
  ) : ensName ? (
    <span className="ens-name">{ensName}</span>
  ) : (
    <code>{showFull ? address : truncated}</code>
  )

  if (asSpan) {
    return <span className="address-display" title={address}>{content}</span>
  }

  return (
    <a
      className="address-display"
      href={etherscanUrl}
      target="_blank"
      rel="noopener noreferrer"
      title={address}
    >
      {content}
    </a>
  )
}
