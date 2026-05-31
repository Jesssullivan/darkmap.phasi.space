# Static Projection Ingest Gate - 2026-05-10

Linear: `TIN-1028`, `TIN-1024`, `TIN-731`

`darkmap.phasi.space` provides the house static-site ingestion gate for reviewed
Tinyland snapshots. The gate exists so generated sister sites can consume
Tinyland hub projections without becoming brokers, mutation APIs, checkout
owners, media authorities, or ActivityPub delivery workers.

## Commands

```bash
just validate-static-projection path/to/public-snapshot.v1.json
just sync-static-projection https://tinyland.dev/projections/<spoke>/public-snapshot.v1.json path/to/public-snapshot.v1.json
just pulse-ingest https://tinyland.dev/projections/<spoke>/pulse/public-snapshot.v1.json static/data/pulse/public-snapshot.v1.json
```

`sync-static-projection` and `pulse-ingest` validate before writing. Remote
sources must be HTTPS URLs without credentials, query parameters, or fragments.
Targets must be local checked-in JSON files.

The commands accept optional spoke-target and actor-document checks:

```bash
just sync-static-projection \
  https://tinyland.dev/projections/software-tinyland-dev/public-snapshot.v1.json \
  src/lib/data/public-snapshot.v1.json \
  software.tinyland.dev \
  https://tinyland.dev/ap/actors/brand/software-tinyland-dev
```

Actor document validation confirms the expected Tinyland brand actor and
published public key are present before a static spoke accepts a refreshed
snapshot. This is a readiness and custody check, not a detached snapshot
signature. Do not describe it as HTTP signature verification until Tinyland
publishes a signed snapshot proof or signed response contract.

## Workflow

`.github/workflows/pulse-ingest.yml` is the propagatable automation layer for
generated sister sites. It runs on schedule and `workflow_dispatch`, validates a
reviewed Tinyland snapshot, runs `just check`, and opens a PR with the changed
checked-in JSON file. The scaffold repo skips scheduled runs because it is the
template, not a live spoke; propagated repos can rely on default repo-name
slugging or set these repository variables:

- `TINYLAND_PROJECTION_SPOKE_SLUG`
- `TINYLAND_PROJECTION_SPOKE_TARGET`
- `TINYLAND_PROJECTION_SOURCE_URL`
- `TINYLAND_PROJECTION_TARGET_PATH`
- `TINYLAND_PROJECTION_ACTOR_URL`

## Validated Shapes

`tinyland.static-spoke.snapshot.v1`:

- `sourceAuthority`;
- `sourceAuthorityUrl`;
- `contentHash`;
- `itemCount`;
- `projectionKind`;
- `spokeTarget`;
- `routePath`;
- `publicSnapshotUrl`;
- no secret-shaped public fields;
- no ActivityPub status that claims public federation launch.

`tinyland.pulse.v1.PublicPulseSnapshot`:

- manifest schema version;
- manifest content hash over canonical public `items`;
- manifest item count;
- M1 public kinds only: `note` and `bird_sighting`;
- no exact location, storage-key, credential, or private-media fields.

## Boundaries

Allowed:

- checked-in static JSON snapshots;
- reviewed Tinyland post, product, service, event, profile, or Pulse
  projections;
- build-time validation and deterministic copy into generated sister-site repos.

Blocked:

- browser or edge runtime fetches from a live broker;
- sister-site mutation APIs;
- auth or payment secret custody;
- checkout sessions, webhooks, settlement, or marketplace automation;
- ActivityPub delivery, inbox, follower, retry, tombstone, or moderation claims.

Public federation remains gated on the `TIN-731` production proof work. This
scaffold only supports static projection ingestion and AP-shaped projection
artifacts.
