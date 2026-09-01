# Upstream map

## Baseline

- Upstream: `swarmclawai/swarmvault`
- Baseline tag: `v3.21.0`
- Baseline commit: `815412d`
- Fork: `kkwbkk/knowledge-os`
- Adapter baseline branch: `feat/capability-os-adapter`
- Viewer/evaluation branch: `feat/capability-os-viewer`

The unmodified baseline passed the full upstream test suite before Capability OS changes were added.

## Private patch surface

| Area | Purpose | Upstream core modified? | Exit path |
|---|---|---:|---|
| `packages/capability-os-adapter` | Read existing Vault, enforce the 13-object contract, separate admission lanes, rebuild isolated retrieval | No | Remove the package and its root build entry |
| `.knowledge-os-runtime/` ignore rule | Keep derived private artifacts out of Git | No | Remove the ignore rule after deleting local runtime data |
| Root build entry | Build the private adapter with the existing workspace | Minimal | Remove one filter from the build script |
| Engine deterministic communities option | Make derived community IDs and summary pages stable across full rebuilds | Yes, small configuration surface | Upstream the option or remove it if upstream provides an equivalent seed/deterministic mode |
| Engine CJK query trigrams | Make natural-language Chinese queries match partial phrases in the existing SQLite trigram index | Yes, small tokenizer correction | Upstream the correction or remove it when upstream ships equivalent CJK query segmentation |
| Engine `/api/capability-os` endpoint | Serve an optional local metadata artifact and evaluation summary | Yes, one optional read-only endpoint | Replace with an upstream extension registry or a generic local-artifact endpoint |
| Viewer `Knowledge OS` tab | Inspect 13 types, four admission lanes, canonical sources, evaluation safety, and one-hop typed relations | Yes, isolated component plus workspace fetch | Move into a viewer plugin slot when upstream exposes one |

No code from llm-wiki-compiler, VaultMind, Personal OS, or next-wiki has been copied at this milestone. Those projects remain design/code donors until a tested requirement justifies a minimal, license-reviewed extraction.
