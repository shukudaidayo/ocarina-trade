# Ocarina ERC-7730 Drafts

Draft ERC-7730 clear-signing descriptors for Ocarina's OTCRegistry integration live here before upstream registry submission.

- `calldata-OTCRegistry.json` describes `registerOrder(OrderRegistration)` transactions.
- `eip712-OTCRegistry.json` describes the OTCRegistry maker registration signature and optional tip authorization signature.
- `tests/` contains reference samples in the format expected by the ERC-7730 registry.

Validate with the official tooling once installed:

```sh
erc7730 lint erc7730/ocarina-trade/calldata-OTCRegistry.json erc7730/ocarina-trade/eip712-OTCRegistry.json
```

For ABI-backed calldata validation, run with network access and `ETHERSCAN_API_KEY` loaded. The calldata descriptor uses the canonical nested tuple display key expected by the Etherscan-backed linter. Array item displays are flattened to explicit `[].field` paths, with hidden array-root fields included so root-path display checks stay quiet without changing wallet output.

## Upstream PR packaging

When preparing the PR for `ethereum/clear-signing-erc7730-registry`:

1. Create `registry/ocarina-trade/` in the registry fork.
2. Copy only the descriptor and test files:
   - `calldata-OTCRegistry.json`
   - `eip712-OTCRegistry.json`
   - `tests/calldata-OTCRegistry.tests.json`
   - `tests/eip712-OTCRegistry.tests.json`
3. Do not copy this README into the upstream registry folder.
4. Change descriptor schemas to `"../../specs/erc7730-v2.schema.json"`.
5. Change test schemas to `"../../../specs/erc7730-tests.schema.json"`.
6. Confirm every listed deployment is verified on Sourcify.
7. Run `erc7730 lint registry/ocarina-trade/calldata-OTCRegistry.json registry/ocarina-trade/eip712-OTCRegistry.json`.

## Upstream Schema Note

Direct `check-jsonschema` validation may reject the canonical `registerOrder(((...) reg)` display key because the current schema regex does not handle this level of nested tuple signature. The descriptor keeps the canonical key anyway because the Etherscan-backed `erc7730 lint` path needs it to match decoded calldata. Hidden `#.reg.components.offer.[]` and `#.reg.components.consideration.[]` root fields are present only to avoid missing-root warnings; the visible item details are still rendered through the flattened child paths.
