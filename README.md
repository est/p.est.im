# my-paste-service.workers.dev - Serverless Paste Service

paste service running on Cloudflare Workers and D1.

## Objective

Provide a zero-friction way to publish temporary outputs online directly from the command line.

`cmd | curl -T - https://my-paste-service.workers.dev`

## Design Rationale

- **D1-only Storage**: To minimize complexity and stay within the Cloudflare free tier, both paste content (as `BLOB`) and metadata are stored in D1. This avoids the overhead of managing R2 while providing sufficient capacity for small pastes (up to 1MB).
- **Aggressive Caching**: To "save cost at all costs," the service leverages the Cloudflare Cache API. Once a paste is fetched from D1, it is cached at the edge until expiration, drastically reducing D1 read operations.
- **Granular Metadata**: Metadata is split into functional fields (`uploader_info`, `counters`, `system_info`) stored as JSON. This keeps the schema clean while allowing for flexible tracking of IP addresses, view counts, and MIME types.
- **Automatic Expiration**: All pastes are set to expire after 24 hours by default to prevent storage bloat and ensure privacy for temporary data.
- **Zero Dependencies**: Built with vanilla TypeScript and standard Cloudflare Worker APIs. No external libraries are used, ensuring a tiny footprint and maximum performance.

## Usage

### Simple Upload (Random ID)
```bash
echo "Hello World" | curl -T - https://my-paste-service.workers.dev
```

### Upload Image/Binary
```bash
curl -T image.png -H "Content-Type: image/png" https://my-paste-service.workers.dev
```

### Deleting a Paste
The upload response includes an `X-Delete-Token` (also available via metadata if requested).
```bash
curl -X DELETE -H "X-Delete-Token: <your-token>" https://my-paste-service.workers.dev/<id>
```

## Local Development

### Prerequisites
- Node.js
- pnpm

### Setup
1. Clone the repository.
2. Install dependencies: `pnpm install`.
3. Apply local migrations: `npx wrangler d1 migrations apply DB --local`.
4. Run dev server: `npm run dev`.

### Testing Locally
```bash
echo "test" | curl -T - http://localhost:8787/
```
