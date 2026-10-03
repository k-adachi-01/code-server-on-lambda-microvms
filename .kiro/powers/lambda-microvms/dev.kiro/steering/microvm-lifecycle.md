---
inclusion: manual
---

# MicroVM lifecycle & snapshot constraints

Guidance for writing code that launches, suspends, resumes, and terminates Lambda MicroVMs.
Lambda MicroVMs are started from **snapshots** of pre-initialized memory and disk state (Firecracker).
That snapshot model drives most of the rules below. When in doubt, retrieve the official AWS
Lambda MicroVMs skill via `aws___retrieve_skill` and read current docs with
`aws___search_documentation`.

## Snapshot compatibility (the big three)

1. **Uniqueness.** Content generated at image-build time is shared across every MicroVM started
   from that image. Generate anything that must be unique — IDs, secrets, random seeds — **after**
   each MicroVM starts, never at build time. If the app uses OpenSSL, build on the AWS base image
   `public.ecr.aws/lambda/microvms:al2023-minimal`.

2. **Ephemeral credentials & connections.** Credentials and network connections established during
   image creation or before suspend may be expired/closed by the time a MicroVM starts or resumes.
   Refresh credentials and re-establish connections on startup. AWS SDK clients usually reconnect
   automatically.

3. **Lifecycle hooks.** MicroVMs provide hooks that run on **start** and on **resume**. Use them to
   restore uniqueness and to re-establish connections/credentials. In this repo the hook handler
   lives under `image/hooks` and is bundled to a single file (no `node_modules` in the image).

## Lifecycle shape in this project

- `launch` → `run-microvm` from the project Image ARN. `maximumDurationInSeconds` (config default
  7200 = 2h) is a **hard upper bound** on lifetime.
- `suspend` → preserves memory + disk at **storage-only rates** (no compute charge while
  suspended, but snapshot storage still bills until terminate).
- `resume` → restores exactly where it left off; expect to re-run start/resume hook logic.
- `terminate` → stops all charges for that MicroVM. Also handle **stray** MicroVMs on the project
  image (`terminate --stray <id>`).

## Cost rules of thumb

- Running MicroVM: compute charges accrue until suspend or terminate.
- Suspended MicroVM: snapshot storage charges accrue until terminate — `status` reminds you.
- Treat `launch` and `terminate` as costed, confirmation-gated operations (PoC Sandbox).

## Idempotency & reconciliation

AWS is the source of truth; local state is a cache. On every command, reconcile local state
against the MicroVM's real status rather than trusting the cache. Keep this decision logic in
`src/core` (pure) and the AWS calls in `src/shell`.
