# Launch metadata schema

Autonomous 314 keeps the on-chain launch payload intentionally small:

- `name`
- `symbol`
- `metadataURI`

Everything richer than that should live behind `metadataURI`.

## Recommended schema

```json
{
  "version": "autonomous314/v1",
  "name": "Autonomous 314",
  "symbol": "A314",
  "description": "A creator-first launch on Autonomous 314.",
  "image": "ipfs://... or https://...",
  "external_url": "https://project.site",
  "website": "https://project.site",
  "twitter": "https://x.com/...",
  "telegram": "https://t.me/...",
  "discord": "https://discord.gg/..."
}
```

## Why this boundary exists

- Rich metadata changes more often than protocol state.
- Images and long strings are expensive to store directly on-chain.
- A metadata JSON can be mirrored to IPFS, Arweave, R2, or any other storage layer without changing the launch contracts.

## Reference frontend behavior

The reference frontend now supports:

- description input
- image URL input
- local image upload for preview/export
- website / X / Telegram / Discord fields
- inline `data:` JSON metadata for lightweight launches
- metadata JSON download for manual publishing to IPFS/R2

## Recommended production flow

1. Fill out the launch form.
2. Publish the metadata JSON to a permanent URI.
3. Paste that URI into the create form.
4. Submit `createLaunchWithSalt(...)`.

Inline metadata is useful for lightweight launches, but a permanent external metadata URI is still the cleaner long-term path.
