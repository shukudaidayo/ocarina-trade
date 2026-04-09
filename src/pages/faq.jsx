import { useState, useEffect, useRef } from 'react'
import { ZONE_ADDRESSES } from '../lib/constants'
import { getEtherscanUrl } from '../lib/verification'

const ZONE_CHAINS = [
  { chainId: 1, name: 'Ethereum' },
  { chainId: 8453, name: 'Base' },
  { chainId: 137, name: 'Polygon' },
  { chainId: 57073, name: 'Ink' },
]

const questions = [
  {
    id: 'what-is',
    q: 'What is Ocarina?',
    a: <><p>Ocarina lets you trade collectibles onchain with anyone, anywhere. OGs will remember the original Sudoswap or OpenSea Deals (RIP) — same idea.</p><p>There's one key difference: Sudoswap and OpenSea Deals didn't pass the walkaway test. Ocarina is built to be easy-to-use, while still being completely free, <a href="https://github.com/shukudaidayo/ocarina-trade" target="_blank" rel="noopener noreferrer">open-source</a>, and minimally reliant on servers or APIs.</p></>,
  },
  {
    id: 'safety',
    q: 'Is Ocarina safe to use?',
    a: <p>Yes. Under the hood, Ocarina uses the <a href="https://github.com/ProjectOpenSea/seaport" target="_blank" rel="noopener noreferrer">Seaport protocol</a>, the very same protocol OpenSea uses to process billions of dollars in trade volume.</p>,
  },
  {
    id: 'audit',
    q: 'Is the Ocarina smart contract audited?',
    a: ({ zoneLinks }) => <><p>Seaport contracts are <a href="https://github.com/trailofbits/publications/blob/master/reviews/SeaportProtocol.pdf" target="_blank" rel="noopener noreferrer">fully audited</a>.</p><p>Besides Seaport, Ocarina relies on a small smart contract, OTCZone, to post offers onchain and limit which cash tokens can be included in Ocarina offers. Although this contract hasn't been audited, it isn't in the flow of assets — even if it does somehow get rekt, your assets are safe.</p><p>The OTCZone contract is deployed at the addresses below:</p>{zoneLinks}</>,
  },
  {
    id: 'assets',
    q: 'What assets can I trade?',
    a: <><p>Ocarina supports most onchain collectibles, WETH, and a limited number of stablecoins. We limit which cash assets you can include in trades so that you never have to wonder if "USDC" is the real deal or a worthless token with the same name.</p><p>Currently, Ocarina supports Ethereum, Polygon, Base, and Ink. Cross-chain trades are not supported — both sides of the trade have to be on the same chain. Solana is not supported.</p></>,
  },
  {
    id: 'fees',
    q: 'What are the trade fees to use Ocarina?',
    a: <p>Ocarina offers 0% trade fees. Only a small amount of gas is required to create, accept, or cancel offers. These gas fees go to blockchain miners and sequencers, not Ocarina.</p>,
  },
  {
    id: 'courtyard-beezie',
    q: 'Can I trade collectibles from Courtyard and Beezie?',
    a: <p>Yes. When you open a pack on Courtyard or Beezie, or buy from their marketplace, they're stored in your Privy wallet. We currently can't connect these wallets to Ocarina, but you can transfer these collectibles to an external wallet, then connect that wallet to Ocarina to trade.</p>,
  },
  {
    id: 'unverified',
    q: 'Why do some assets show as "unverified"?',
    a: <><p>To help prevent scams, Ocarina uses <a href="https://www.alchemy.com/nft-api" target="_blank" rel="noopener noreferrer">Alchemy</a> to verify collectibles. When accepting an offer with assets from unverified collections, we'll warn you and show you the unverified contract addresses before you can accept the trade — we recommend that you search these contracts on OpenSea or another data source, so you know what you're getting.</p><p>Alchemy currently doesn't support Ink collectibles, so you'll see this warning on every Ink trade.</p></>,
  },
  {
    id: 'multiple-offers',
    q: 'Can I offer the same asset on Ocarina and on another marketplace?',
    a: <p>Yes. When you create an offer on Ocarina, assets remain in your wallet until someone accepts the offer. So, you're free to make as many offers as you want, here or elsewhere, and once the asset has been traded to someone else, all other offers can no longer be accepted.</p>,
  },
  {
    id: 'cancel',
    q: 'Can I cancel my offer?',
    a: <p>Yes. Visit the offer page for the offer you want to cancel, connect the same wallet you used to create the offer, and click Cancel Offer. You will need to pay a small amount of gas to cancel.</p>,
  },
  {
    id: 'token',
    q: 'Is there an official Ocarina token?',
    a: <p>Buy Bitcoin, you degenerate.</p>,
  },
  {
    id: 'contact',
    q: 'I have another question or feedback',
    a: <p>DM <a href="https://x.com/shukudaidayo" target="_blank" rel="noopener noreferrer">@shukudaidayo</a> on Twitter.</p>,
  },
]

export default function FAQ() {
  useEffect(() => { document.title = 'FAQ — ocarina.trade' }, [])
  const [activeId, setActiveId] = useState(questions[0].id)
  const sectionRefs = useRef({})

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        let topEntry = null
        for (const entry of entries) {
          if (entry.isIntersecting) {
            if (!topEntry || entry.boundingClientRect.top < topEntry.boundingClientRect.top) {
              topEntry = entry
            }
          }
        }
        if (topEntry) {
          setActiveId(topEntry.target.id)
        }
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 }
    )

    for (const el of Object.values(sectionRefs.current)) {
      if (el) observer.observe(el)
    }

    return () => observer.disconnect()
  }, [])

  const scrollTo = (id) => {
    const el = sectionRefs.current[id]
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  const zoneLinks = (
    <span className="faq-zone-links">
      {ZONE_CHAINS.map(({ chainId, name }) => (
        <span key={chainId}>
          {name}: <a href={getEtherscanUrl(chainId, ZONE_ADDRESSES[chainId])} target="_blank" rel="noopener noreferrer"><code>{ZONE_ADDRESSES[chainId]}</code></a>
        </span>
      ))}
    </span>
  )

  return (
    <div className="page faq">
      <h1>FAQ</h1>

      <div className="faq-layout">
        <nav className="faq-sidebar">
          {questions.map(({ id, q }) => (
            <button
              key={id}
              className={`faq-sidebar-link${activeId === id ? ' active' : ''}`}
              onClick={() => scrollTo(id)}
            >
              {q}
            </button>
          ))}
        </nav>

        <div className="faq-content">
          {questions.map(({ id, q, a }) => (
            <section
              key={id}
              id={id}
              ref={(el) => { sectionRefs.current[id] = el }}
              className="faq-item"
            >
              <h2>{q}</h2>
              <div className="faq-answer">{typeof a === 'function' ? a({ zoneLinks }) : a}</div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
