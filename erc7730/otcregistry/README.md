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

## Known linter warning

The ABI-backed linter currently warns that `#.reg.components.offer.[]` and `#.reg.components.consideration.[]` are missing display fields. This is expected: those array roots are grouped descriptors, and the useful child fields are rendered inside each item. Adding duplicate hidden fields for the roots makes the linter quiet, but duplicate paths are not used by existing registry entries and could be less portable across wallet implementations.

Approved registry entries with the same warning shape include:

- `registry/safe/calldata-BatchExecutor.json`: displays `calls.[].data` but lints with missing `#.calls.[]`.
- `registry/morpho/calldata-MorphoBundlerV3.json`: displays `#.bundle.[].data` but lints with missing `#.bundle.[]`.
- `registry/paraswap/calldata-AugustusSwapper-v6.2.json`: displays / hides child paths under `#.orders.[]` but lints with missing `#.orders.[]`.
