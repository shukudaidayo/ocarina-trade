import { createAppKit } from '@reown/appkit/react'
import { EthersAdapter } from '@reown/appkit-adapter-ethers'
import { mainnet, base, polygon } from '@reown/appkit/networks'

const projectId = import.meta.env.VITE_REOWN_PROJECT_ID

const metadata = {
  name: 'ocarina.trade',
  description: 'Peer-to-peer NFT swaps, fully on-chain',
  url: window.location.origin,
  icons: [],
}

createAppKit({
  adapters: [new EthersAdapter()],
  networks: [mainnet, base, polygon],
  defaultNetwork: mainnet,
  metadata,
  projectId,
  features: {
    email: false,
    socials: false,
  },
})
