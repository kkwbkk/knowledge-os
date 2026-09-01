# Capability OS adapter

This fork keeps the user's Obsidian Vault and `.knowledge-system/schema.yaml` as the source of truth. The adapter is deliberately read-only: it scans Markdown, validates the 13-object contract, normalizes links and relations, and assigns every object to one deterministic admission lane.

## Admission lanes

- `searchable`: accepted content objects plus valid non-ingest-controlled business/system objects.
- `review-only`: `raw` or `pending` content objects. They may appear in review UI but never in default retrieval.
- `excluded`: rejected, archived, or template objects.
- `invalid`: contract failures, unknown types, parse errors, or duplicate IDs.

The five ingest-controlled types are `source`, `learning`, `knowledge`, `playbook`, and `artifact`. A searchable object of any of these types must have `ingest_status: accepted`; the adapter asserts this invariant before returning a snapshot.

## Run a private metadata scan

Use Node.js 24 or newer:

```bash
pnpm --filter @knowledge-os/capability-os-adapter build
node packages/capability-os-adapter/dist/cli.js \
  --vault "/absolute/path/to/your/Obsidian/Vault" \
  --scope "能力操作系统"
```

The command prints counts, a rebuild hash, and validation issues. It does not write to the Vault and does not print note bodies. Future retrieval artifacts belong under the ignored `.knowledge-os-runtime/` directory, never beside canonical notes.

## Rebuild the isolated retrieval runtime

```bash
node packages/capability-os-adapter/dist/rebuild-cli.js \
  --vault "/absolute/path/to/your/Obsidian/Vault" \
  --runtime "/absolute/path/to/knowledge-os/.knowledge-os-runtime" \
  --scope "能力操作系统" \
  --query "a private smoke-test query"
```

The runtime command refuses to write inside the Vault and refuses to replace a non-empty runtime directory unless it carries the Capability OS marker. Every rebuild deletes only its marked derived SwarmVault workspace, regenerates the projection from canonical Markdown, imports searchable objects, and builds a fresh SQLite retrieval index. Query output contains page metadata but not snippets or note bodies.

## Upstream boundary

This package is isolated from SwarmVault core so upstream releases can be merged with a small patch surface. It converts `searchable` records into a disposable SwarmVault projection while keeping review-only records out of default retrieval. The next UI step will expose the review lane and typed one-hop relations without granting arbitrary Vault writes.
