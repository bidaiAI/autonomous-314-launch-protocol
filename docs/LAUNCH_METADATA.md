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

## Recommended image guidance

To align better with launch cards, token detail pages, bots, and wallet listings:

- use a **square** cover image whenever possible
- keep the main logo / mascot / wordmark in the **center safe area**
- avoid important text or logos near the edges because several surfaces crop with `cover`
- prefer **PNG**, **JPG**, or **WebP**
- **400 × 400 px** can work for fast creation flows
- aim for **1000 × 1000 px or above** for sharper cards and wallet/bot rendering
- keep files roughly **1 MB** when possible for smoother metadata handling

The reference frontend accepts local image uploads for preview, but the production-friendly path is still:

1. host the final image at a permanent URL
2. place that URL in `image`
3. publish the metadata JSON to a permanent `metadataURI`

The create page also supports **local square crop preview** so creators can center artwork before exporting metadata.

This keeps third-party consumers consistent:

- bots can render the logo from `image`
- wallets can hydrate project identity from `image` + social links
- custom frontends can reuse the same metadata without guessing image policy

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
