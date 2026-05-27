# OTCRegistry ERC-7730 Drafts

Draft ERC-7730 clear-signing descriptors for OTCRegistry live here before upstream registry submission.

- `calldata-OTCRegistry.json` describes `registerOrder(OrderRegistration)` transactions.
- `eip712-OTCRegistry.json` describes the OTCRegistry maker registration signature and optional tip authorization signature.
- `tests/` contains reference samples in the format expected by the ERC-7730 registry.

Validate with the official tooling once installed:

```sh
erc7730 lint erc7730/otcregistry/calldata-OTCRegistry.json erc7730/otcregistry/eip712-OTCRegistry.json
```

For ABI-backed calldata validation, run with network access and `ETHERSCAN_API_KEY` loaded. Array item displays are flattened to explicit `[].field` paths because upstream schema validation is stricter than `erc7730 lint` around grouped array display fields.

## Upstream PR packaging

When preparing the PR for `ethereum/clear-signing-erc7730-registry`:

1. Create `registry/otcregistry/` in the registry fork.
2. Copy only the descriptor and test files:
   - `calldata-OTCRegistry.json`
   - `eip712-OTCRegistry.json`
   - `tests/calldata-OTCRegistry.tests.json`
   - `tests/eip712-OTCRegistry.tests.json`
3. Do not copy this README into the upstream registry folder.
4. Change descriptor schemas to `"../../specs/erc7730-v2.schema.json"`.
5. Change test schemas to `"../../../specs/erc7730-tests.schema.json"`.
6. Confirm every listed deployment is verified on Sourcify.
7. Run `erc7730 lint registry/otcregistry/calldata-OTCRegistry.json registry/otcregistry/eip712-OTCRegistry.json`.

## Known Upstream Schema Caveat

The calldata descriptor uses the canonical nested ABI signature for `registerOrder(((...) reg)` as the display format key. The current upstream `check-jsonschema` regex may reject that deeply nested signature key, and selector-style keys appear to hit the same schema limitation even though ERC-7730 allows selectors. `erc7730 lint` accepts the descriptor; mention this in the upstream PR if schema validation flags the calldata format key.
