# OTCRegistry ERC-7730 Drafts

Draft ERC-7730 clear-signing descriptors for OTCRegistry live here before upstream registry submission.

- `calldata-OTCRegistry.json` describes `registerOrder(OrderRegistration)` transactions.
- `eip712-OTCRegistry.json` describes the OTCRegistry maker registration signature and optional tip authorization signature.
- `tests/` contains reference samples in the format expected by the ERC-7730 registry.

Validate with the official tooling once installed:

```sh
erc7730 lint erc7730/otcregistry/calldata-OTCRegistry.json erc7730/otcregistry/eip712-OTCRegistry.json
```

For ABI-backed calldata validation, run with network access and `ETHERSCAN_API_KEY` loaded. The current linter may warn that the `offer[]` and `consideration[]` array roots are missing display fields even though their child fields are intentionally rendered through grouped array item descriptors.
