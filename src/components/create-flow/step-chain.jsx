import { useState } from 'react'
import { ethers } from 'ethers'
import { useCreateFlow } from './context'
import { ZONE_ADDRESSES, SELECTABLE_CHAIN_IDS, CHAINS } from '../../lib/constants'

const CHAIN_LOGOS = {
  1: new URL('../../assets/tokens/eth.png', import.meta.url).href,
  8453: new URL('../../assets/chains/base.jpg', import.meta.url).href,
  137: new URL('../../assets/tokens/pol.png', import.meta.url).href,
}

const CHAIN_DESCRIPTIONS = {
  1: 'OG NFTs and ENS names',
  8453: 'Beezie, Slab, and RIP.FUN',
  137: 'Courtyard collectibles',
}

function getSwapUrl(chainId) {
  const symbol = CHAINS[chainId]?.nativeSymbol || 'ETH'
  const slugs = { 1: 'mainnet', 8453: 'base', 137: 'polygon' }
  return { url: `https://app.uniswap.org/swap?chain=${slugs[chainId]}&outputCurrency=NATIVE`, label: `Buy ${symbol} on Uniswap` }
}

const SELECTABLE_CHAINS = SELECTABLE_CHAIN_IDS.filter((id) => ZONE_ADDRESSES[id])

export default function StepChain({ wallet }) {
  const { next, chainId, setChainId, setMakerAssets, setTakerAssets } = useCreateFlow()
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
        await switchWalletNetwork(wallet.provider, id)
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
        {SELECTABLE_CHAINS.map((id) => (
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

async function switchWalletNetwork(provider, chainId) {
  const chain = CHAINS[chainId]
  const hexChainId = '0x' + chainId.toString(16)
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexChainId }],
    })
  } catch (err) {
    if (err?.code !== 4902 && err?.data?.originalError?.code !== 4902) throw err
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: hexChainId,
        chainName: chain?.name || `Chain ${chainId}`,
        nativeCurrency: { name: chain?.nativeSymbol || 'Ether', symbol: chain?.nativeSymbol || 'ETH', decimals: 18 },
        rpcUrls: [chain?.rpcUrl],
        blockExplorerUrls: chain?.blockscoutApi ? [chain.blockscoutApi.replace(/\/api\/?$/, '')] : undefined,
      }],
    })
  }
}
