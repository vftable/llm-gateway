# Key Management

Reference for the structured provider key system — per-key metadata,
batch operations, URL import, and background polling.

---

## Provider Key Schema

Every upstream API key is stored as a structured row in the `provider_keys`
table. Keys are **never** stored on the `providers` table directly (the legacy
`api_keys` / `disabled_api_keys` JSON arrays have been removed).

### `ProviderKey` fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | 8-char hex random identifier |
| `providerId` | `string` | FK → `providers.id` (CASCADE delete) |
| `credential` | `string` | The raw API key (e.g. `sk-abc123…`) |
| `credHash` | `string` | SHA-256 hex prefix (32 chars) of `credential` — same algorithm used by KeyHealthStore for health tracking and affinity |
| `enabled` | `boolean` | Whether the key participates in round-robin rotation |
| `metadata` | `Record<string, string>` | Arbitrary key-value pairs (uuid, email, tier, etc.) |
| `label` | `string \| null` | Optional human-readable name |
| `createdAt` | `string` | ISO-8601 timestamp |
| `updatedAt` | `string` | ISO-8601 timestamp |

Uniqueness is enforced by `(provider_id, cred_hash)` — adding a duplicate
credential to the same provider is a no-op.

### `KeyCount`

The `Provider` type exposes a summary instead of the full key list:

```typescript
interface KeyCount {
  enabled: number;
  disabled: number;
  total: number;
}
```

Access via `provider.keyCount`. Use `GET /providers/:id/keys` to fetch the
full structured key list.

---

## REST API

All endpoints require admin authentication (`Authorization: Bearer <token>`).
All mutations trigger a router reload and broadcast `provider:update` via
WebSocket.

### Single-Key CRUD

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/providers/:id/keys` | List all keys (paginated via `?offset=&limit=`) |
| `POST` | `/api/providers/:id/keys` | Create a single key |
| `PUT` | `/api/providers/:id/keys/:keyId` | Update key (metadata, label, enabled) |
| `DELETE` | `/api/providers/:id/keys/:keyId` | Delete a single key |

#### Create request body

```json
{
  "credential": "sk-abc123…",
  "metadata": { "uuid": "550e8400-…", "email": "ops@example.com" },
  "label": "production-1"
}
```

Only `credential` is required. `metadata` defaults to `{}`, `enabled` defaults
to `true`.

#### Update request body

```json
{
  "enabled": false,
  "metadata": { "uuid": "550e8400-…", "tier": "enterprise" },
  "label": "production-1-paused"
}
```

All fields are optional — only provided fields are changed.

### Batch Operations

```
POST /api/providers/:id/keys/batch
```

Atomic transaction — all operations succeed or none do. Max **5,000** total
operations per call.

#### Request body

```json
{
  "add": [
    { "credential": "sk-new1", "metadata": { "email": "a@b.com" } },
    { "credential": "sk-new2", "label": "backup" }
  ],
  "remove": ["keyId1", "keyId2"],
  "update": [
    { "id": "keyId3", "label": "renamed", "metadata": { "tier": "pro" } }
  ],
  "enable": ["keyId4"],
  "disable": ["keyId5", "keyId6"]
}
```

All arrays are optional. Duplicates in `add` are silently skipped.

#### Response

```json
{
  "added": 2,
  "removed": 2,
  "updated": 1,
  "enabled": 1,
  "disabled": 2,
  "duplicatesSkipped": 0,
  "errors": [],
  "keys": [ /* full updated key list */ ]
}
```

### Other Batch Endpoints

The same atomic-transaction pattern applies to these entities:

| Endpoint | Operations |
|----------|-----------|
| `POST /api/api-keys/batch` | `create`, `update`, `delete`, `enable`, `disable` |
| `POST /api/models/batch` | `create`, `update`, `delete`, `enable`, `disable` |
| `POST /api/models/:id/providers/batch` | `add`, `remove`, `update`, `reorder` fallback-chain links |
| `POST /api/providers/batch` | `update`, `delete`, `enable`, `disable` |

For fallback-chain `reorder`, send an ordered array of
`{ "providerId": "…", "upstreamModel": "…" }` identities. Listed links move
to the front in that exact order; omitted links retain their relative order
afterward. The entire link batch is atomic.

---

## URL Import

```
POST /api/providers/:id/keys/import
```

Fetches keys from an external URL and inserts them via the batch mechanism.
30-second timeout, 10 MB max response.

### Request body

```json
{
  "url": "https://your-backend.example.com/api/keys",
  "headers": { "Authorization": "Bearer my-internal-token" },
  "mode": "replace",
  "defaultMetadata": { "source": "auto-import" }
}
```

Only `url` is required. `mode` defaults to `"append"`.

| Mode | Behavior |
|------|----------|
| `append` | Add new keys, skip duplicates. Existing keys are untouched. |
| `replace` | Add new keys. **Disable** (not delete) keys not in the response. Re-enable keys that reappear. Preserves health data and affinity. |

### Response

```json
{
  "batch": { /* BatchKeyResult */ },
  "fetched": 42,
  "mode": "replace"
}
```

---

## Key Poll Data Schema

This section describes how to implement a custom backend that serves keys for
the gateway's background polling. Your endpoint must return one of three
formats (auto-detected).

### Format 1: JSON String Array

The simplest format — an array of credential strings.

```json
["sk-key-alpha", "sk-key-beta", "sk-key-gamma"]
```

No metadata or labels. Use `defaultMetadata` on the sync config or import
request to attach common metadata to all keys.

### Format 2: JSON Object Array (recommended)

Full control over per-key metadata, labels, and enabled state.

```json
[
  {
    "credential": "sk-key-alpha",
    "metadata": {
      "uuid": "550e8400-e29b-41d4-a716-446655440001",
      "email": "team-a@example.com",
      "tier": "enterprise"
    },
    "label": "prod-us-east-1"
  },
  {
    "credential": "sk-key-beta",
    "metadata": {
      "uuid": "550e8400-e29b-41d4-a716-446655440002",
      "email": "team-b@example.com"
    },
    "label": "staging",
    "enabled": true
  }
]
```

#### Object fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `credential` | `string` | **yes** | The raw API key |
| `key` | `string` | alt | Alias for `credential` (either works) |
| `metadata` | `Record<string, string>` | no | Arbitrary key-value pairs — merged with `defaultMetadata` (per-key values win) |
| `label` | `string` | no | Human-readable identifier |
| `enabled` | `boolean` | no | Defaults to `true` if omitted |

Each poll is a structured upsert. For an existing credential, supplied
`metadata`, `label`, and `enabled` values replace those fields locally; omitted
fields are preserved in append mode. In replace mode, present keys default to
enabled unless they explicitly set `enabled:false`, while missing keys are
disabled. A successful empty replace response therefore disables every key.

### Format 3: Newline-Delimited Text

One key per line. Lines starting with `#` are treated as comments and skipped.
Empty lines are ignored.

```text
# Production keys
sk-key-alpha
sk-key-beta
# Staging
sk-key-gamma
```

No metadata or labels in this format.

### Example: Custom Key Server (Node.js/Express)

A minimal backend that serves the object-array format with per-key metadata:

```javascript
app.get("/api/keys", (req, res) => {
  // Authenticate the gateway's poll request
  if (req.headers.authorization !== `Bearer ${process.env.POLL_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  // Build the key list from your database/vault/secrets manager
  const keys = db.query("SELECT * FROM api_keys WHERE active = 1").all();

  res.json(
    keys.map((k) => ({
      credential: k.api_key,
      metadata: {
        uuid: k.id,
        email: k.owner_email,
        tier: k.subscription_tier,
      },
      label: k.display_name,
    })),
  );
});
```

To **revoke a key**, simply stop including it in the response. On the next
poll cycle the gateway will disable it automatically (preserving health data
so it can be re-enabled later if it reappears).

### Example: Custom Key Server (Python/Flask)

```python
@app.route("/api/keys")
def list_keys():
    if request.headers.get("Authorization") != f"Bearer {POLL_SECRET}":
        abort(401)

    keys = db.execute("SELECT * FROM api_keys WHERE active = 1").fetchall()
    return jsonify([
        {
            "credential": k["api_key"],
            "metadata": {
                "uuid": k["id"],
                "email": k["owner_email"],
            },
            "label": k["display_name"],
        }
        for k in keys
    ])
```

---

## Background Polling

Configure a provider to periodically fetch keys from a URL. The URL response
is the **source of truth**:

- Keys in the response that don't exist locally are **added**
- Keys in the response that exist but are disabled are **re-enabled**
- Local keys not in the response are **disabled** (not deleted) — health data,
  affinity, and metadata are preserved
- Keys that reappear in a later poll are **re-enabled** automatically

This makes it simple to kill a key from your backend without touching the
gateway UI: just remove it from the response and the next poll cycle disables
it.

### Sync Config API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/providers/:id/keys/sync` | Read sync config (or `null`) |
| `PUT` | `/api/providers/:id/keys/sync` | Create or update sync config |
| `DELETE` | `/api/providers/:id/keys/sync` | Remove sync config and stop polling |
| `POST` | `/api/providers/:id/keys/sync/trigger` | Manual poll now (uses configured URL) |

### Sync Config Fields

```json
{
  "pollUrl": "https://your-backend.example.com/api/keys",
  "pollHeaders": { "Authorization": "Bearer my-internal-token" },
  "pollIntervalSec": 300,
  "enabled": true
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `pollUrl` | `string` | — | **Required.** URL to fetch keys from |
| `pollHeaders` | `Record<string, string>` | `{}` | Headers attached to every poll request (e.g. auth tokens) |
| `pollIntervalSec` | `number` | `300` | Minimum 30 seconds |
| `enabled` | `boolean` | `true` | Pause/resume without deleting config |

### Read-only status fields (returned in GET)

| Field | Type | Description |
|-------|------|-------------|
| `lastSyncedAt` | `string \| null` | ISO-8601 timestamp of last poll attempt |
| `lastSyncError` | `string \| null` | Error message from last failed poll (cleared on success) |

### Error handling

- Poll failures are logged and stored in `lastSyncError`, but polling
  continues on the next interval — one transient failure doesn't stop the
  service
- The poll timer is `unref()`'d so it doesn't prevent Node.js from exiting
  during graceful shutdown
- `KeySyncService.stop()` is called during server shutdown before the DB is
  closed

---

## Per-Key Metadata

Metadata is a `Record<string, string>` — flat string key-value pairs attached
to each key. There is no enforced schema; use whatever keys make sense for
your organization.

### Recommended patterns

| Key | Example | Use case |
|-----|---------|----------|
| `uuid` | `550e8400-…` | Correlate with external billing/identity systems |
| `email` | `ops@example.com` | Track which team/person owns a key |
| `tier` | `enterprise` | Tag keys by subscription level |
| `region` | `us-east-1` | Geographic affinity tagging |
| `source` | `auto-import` | Track how the key was added |
| `expires` | `2025-12-31` | Soft expiration hint (gateway doesn't auto-disable — your poll source should handle expiry) |

Metadata is stored as JSON in the `provider_keys` table and is returned on all
key list/detail endpoints. The gateway resolves metadata for the exact key
selected by health-aware rotation and exposes it to request transforms and
provider builders as `ctx.keyMetadata`. Usage/stat adapters receive the same
key-specific object as `UsageCtx.keyMetadata`, so a custom adapter can pass a
uuid or email to the provider's statistics endpoint without parsing it from
the credential. Metadata does not alter routing automatically; the adapter or
transform decides how to use it.

---

## Legacy Compatibility

The `ProviderInput` type still accepts `apiKeys` and `disabledApiKeys` string
arrays for backwards compatibility with existing integrations. When these
fields are provided in a `POST /api/providers` or `PUT /api/providers/:id`
request, they are internally routed through `batchProviderKeys()`:

- `apiKeys` entries are added as enabled keys (duplicates skipped)
- `disabledApiKeys` entries are added as disabled keys

This shim exists for migration convenience. New integrations should use the
`/providers/:id/keys/batch` endpoint directly.

### Migration from legacy DB

On first startup after upgrade, the gateway automatically migrates existing
`api_keys` and `disabled_api_keys` JSON arrays from the `providers` table
into the new `provider_keys` table. The `cred_hash` values are computed using
the same SHA-256 algorithm as `KeyHealthStore`, so existing health tracking
and model affinity data carries over seamlessly.

---

## Gateway API Key Security

Gateway API keys (used by clients to authenticate with the gateway) are stored
as SHA-256 hashes only. The full plaintext key is returned exactly once — at
creation time — and is never persisted or retrievable afterwards. There is no
"reveal" or "copy full key" endpoint.
