import { useState } from 'react'
import { ethers } from 'ethers'
import { useCreateFlow } from './context'
import { ZONE_ADDRESSES, CHAINS } from '../../lib/constants'
import { useAppKitNetwork } from '@reown/appkit/react'
import { mainnet, base, polygon } from '@reown/appkit/networks'
import { ink } from '../../lib/appkit'

const APPKIT_NETWORKS = {
  1: mainnet,
  8453: base,
  137: polygon,
  57073: ink,
}

const CHAIN_LOGOS = {
  1: new URL('../../assets/tokens/eth.png', import.meta.url).href,
  8453: new URL('../../assets/chains/base.jpg', import.meta.url).href,
  137: new URL('../../assets/tokens/pol.png', import.meta.url).href,
  57073: new URL('../../assets/chains/ink.png', import.meta.url).href,
}

const CHAIN_DESCRIPTIONS = {
  1: 'OG NFTs and ENS names',
  8453: 'Beezie, Slab, and other collectibles',
  137: 'Courtyard collectibles',
  57073: 'Select Phygitals collectibles',
}

function getSwapUrl(chainId) {
  const symbol = CHAINS[chainId]?.nativeSymbol || 'ETH'
  if (chainId === 57073) {
    return { url: 'https://velodrome.finance/swap?to=eth&chain1=57073', label: `Buy ${symbol} on Velodrome` }
  }
  const slugs = { 1: 'mainnet', 8453: 'base', 137: 'polygon' }
  return { url: `https://app.uniswap.org/swap?chain=${slugs[chainId]}&outputCurrency=NATIVE`, label: `Buy ${symbol} on Uniswap` }
}

const DEPLOYED_CHAINS = Object.entries(ZONE_ADDRESSES)
  .filter(([, addr]) => addr !== null)
  .map(([id]) => Number(id))

export default function StepChain({ wallet }) {
  const { next, chainId, setChainId, setMakerAssets, setTakerAssets } = useCreateFlow()
  const { switchNetwork } = useAppKitNetwork()
  const [noGasChain, setNoGasChain] = useState(null)

  const handleSelect = async (id) => {
    // If changing chain, clear any previously selected assets
    if (chainId && chainId !== id) {
      setMakerAssets([])
      setTakerAssets([])
    }

    setChainId(id)

    // Switch wallet network if needed
    if (wallet.chainId !== id) {
      try {
        await switchNetwork(APPKIT_NETWORKS[id])
      } catch {
        // User rejected — stay on this screen
        return
      }
    }

    // Check gas balance on selected chain
    try {
      const provider = new ethers.JsonRpcProvider(CHAINS[id].rpcUrl)
      const balance = await provider.getBalance(wallet.address)
      if (balance === 0n) {
        setNoGasChain(id)
        return
      }
    } catch {
      // RPC error — don't block the user
    }

    next()
  }

  const swap = noGasChain ? getSwapUrl(noGasChain) : null

  return (
    <div className="wizard-screen">
      <h2>Which chain are you trading on?</h2>
      <div className="chain-cards">
        {DEPLOYED_CHAINS.map((id) => (
          <button
            key={id}
            className={`chain-card${chainId === id ? ' chain-card-active' : ''}`}
            onClick={() => handleSelect(id)}
            type="button"
          >
            {CHAIN_LOGOS[id] && <img src={CHAIN_LOGOS[id]} alt="" className="chain-card-logo" />}
            <div className="chain-card-text">
              <span className="chain-card-name">{CHAINS[id]?.name || `Chain ${id}`}</span>
              <span className="chain-card-desc">{CHAIN_DESCRIPTIONS[id] || ''}</span>
            </div>
          </button>
        ))}
      </div>

      {noGasChain && (
        <div className="modal-overlay" onClick={() => setNoGasChain(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>No {CHAINS[noGasChain]?.nativeSymbol || 'gas'} detected</h3>
            <p>
              Creating an offer requires a small amount of {CHAINS[noGasChain]?.nativeSymbol || 'gas'} for
              transaction fees on {CHAINS[noGasChain]?.name}.
            </p>
            <p>
              <a href={swap.url} target="_blank" rel="noopener noreferrer">{swap.label}</a>
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => { setNoGasChain(null); next() }}>
                Continue Anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
