export default function WarningBanner() {
  return (
    <div className="warning-banner">
      <strong>Always verify contract addresses before accepting a trade.</strong>{' '}
      Scammers create fake tokens that look identical to valuable ones.
      Check each contract address on Etherscan to confirm it is the real collection.
    </div>
  )
}
