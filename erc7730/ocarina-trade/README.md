# Ocarina ERC-7730 Registry Mirror

This directory mirrors the ERC-7730 clear-signing descriptors submitted for Ocarina's OTCRegistry integration. The active upstream submission lives in the `ocarina-trade` branch of the registry fork:

https://github.com/shukudaidayo/clear-signing-erc7730-registry/tree/ocarina-trade/registry/ocarina-trade

Once merged, the canonical public copy for wallet distribution is expected to live under `registry/ocarina-trade/` in:

https://github.com/ethereum/clear-signing-erc7730-registry

- `calldata-OTCRegistry.json` describes `registerOrder(OrderRegistration)` transactions.
- `eip712-OTCRegistry.json` describes the OTCRegistry maker registration signature and optional tip authorization signature.
- `tests/` contains reference samples in the format expected by the ERC-7730 registry.

The JSON files intentionally keep registry-relative `$schema` paths such as `../../specs/erc7730-v2.schema.json`, matching the upstream PR package. For validation, run the official tooling from a checkout of `clear-signing-erc7730-registry` after copying or syncing these files into `registry/ocarina-trade/`:

```sh
erc7730 lint registry/ocarina-trade/calldata-OTCRegistry.json registry/ocarina-trade/eip712-OTCRegistry.json
```

For ABI-backed calldata validation, run with network access and `ETHERSCAN_API_KEY` loaded. The calldata descriptor uses the canonical nested tuple display key expected by the Etherscan-backed linter.

## Maintenance

Treat the upstream registry PR, and eventually the merged upstream registry folder, as the canonical wallet-distribution source. This local copy exists so the Ocarina repo keeps a reviewed snapshot next to the contract constants, tests, and spec history.

When the upstream PR changes, mirror the four JSON files here:

- `calldata-OTCRegistry.json`
- `eip712-OTCRegistry.json`
- `tests/calldata-OTCRegistry.tests.json`
- `tests/eip712-OTCRegistry.tests.json`

Do not copy this README into the upstream registry folder.
