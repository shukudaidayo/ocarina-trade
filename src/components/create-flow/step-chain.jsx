import { useCreateFlow } from './context'
import { ZONE_ADDRESSES, CHAINS } from '../../lib/constants'
import { useAppKitNetwork } from '@reown/appkit/react'
import { mainnet, base, polygon } from '@reown/appkit/networks'

const APPKIT_NETWORKS = {
  1: mainnet,
  8453: base,
  137: polygon,
}

const CHAIN_DESCRIPTIONS = {
  1: 'OG NFTs, CryptoPunks, Art Blocks, etc.',
  8453: 'Beezie, Slab, and other collectibles',
  137: 'Courtyard collectibles',
}

const DEPLOYED_CHAINS = Object.entries(ZONE_ADDRESSES)
  .filter(([, addr]) => addr !== null)
  .map(([id]) => Number(id))

export default function StepChain({ wallet }) {
  const { next, chainId, setChainId, setMakerAssets, setTakerAssets } = useCreateFlow()
  const { switchNetwork } = useAppKitNetwork()

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

    next()
  }

  return (
    <div className="wizard-screen">
      <h2>Which chain are you trading on?</h2>
      <div className="chain-cards">
        {DEPLOYED_CHAINS.map((id) => (
          <button
            key={id}
            className={`chain-card${(chainId ?? wallet?.chainId) === id ? ' chain-card-active' : ''}`}
            onClick={() => handleSelect(id)}
            type="button"
          >
            <span className="chain-card-name">{CHAINS[id]?.name || `Chain ${id}`}</span>
            <span className="chain-card-desc">{CHAIN_DESCRIPTIONS[id] || ''}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
