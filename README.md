# mls-testbed

Empirical evaluation testbed for the paper
**"Messaging Layer Security (MLS): Sicherheitsanalyse des IETF-Gruppenmessaging-Protokolls"**
DHBW Stuttgart — Simon Chasi & Ognjen Jovanovic

---

## Purpose

This testbed simulates four adversarial attack scenarios against an MLS (RFC 9420) group to
produce empirical measurements for the paper's security evaluation. It does not implement MLS
itself — it drives the `mls-rs` Rust library through a subprocess interface and observes what
an adversary positioned at the relay layer can learn.

Each scenario generates a structured JSONL event log and a set of PDF figures for inclusion in
the paper.

### Attack vectors

| Vector | Description | Owner |
|--------|-------------|-------|
| vector1 | Metadata inference — passive relay observer classifies MLS operation types from message size alone | Simon |
| vector2 | PCS recovery — demonstrates that a compromised client state cannot decrypt messages after subsequent self-update commits | Ognjen |
| vector3 | Async delivery — measures state convergence cost when a client processes a backlog of missed commits | Ognjen |
| vector4 | Commit-size scaling — empirically verifies that MLS commit sizes grow as O(log N) with group size, confirming a passive observer can infer approximate group cardinality from a single commit | Simon |

### How it works

```
TypeScript simulator
  └─ spawns one mls-cli process per simulated client
       └─ communicates via newline-delimited JSON on stdin/stdout
  └─ routes all messages through an in-process Relay
       └─ Relay logs every message_sent / message_delivered event to JSONL
  └─ after scenario completes, Python analysis reads the log and writes PDF figures
```

---

## Running the testbed

Docker is the only supported method. It handles compilation of the Rust binary, TypeScript
execution, and Python analysis in a single reproducible environment.

### Prerequisites

- Docker with Compose (`docker compose version`) — the only requirement
- Docker Desktop (Windows/macOS) or Colima (`colima start` on macOS) or Docker Engine (Linux)

No Rust, Node.js, or Python installation is needed on the host machine. The image builds natively
for the host architecture (arm64 on Apple Silicon, amd64 on Linux/Windows), so it runs identically
on macOS, Linux, and Windows (via WSL2 or Docker Desktop). The first build takes several minutes
for Rust compilation; subsequent runs use the cached layer unless `mls-cli/src/` or `Cargo.toml`
changes.

### Run a single vector

```bash
docker compose up --build vector1
docker compose up --build vector4
```

### Run all four vectors

```bash
docker compose up --build all
```

### Custom seed

```bash
SEED=1337 docker compose up vector1
```

The default seed is `42`. The seed controls the scenario structure (which member acts when,
random payload sizes, operation selection in vector 4) but not MLS cryptographic randomness.

### Output

After a successful run:

- `logs/vector1_v1_seed42.jsonl` — raw event log (gitignored)
- `figures/vector1_size_distribution.pdf` — for LaTeX inclusion
- `figures/vector1_timeline.pdf` — for LaTeX inclusion

### Known limitations

**vector4 at N=128 requires sufficient OS thread headroom.** The scenario runs 128 `mls-cli`
processes simultaneously; each initialises a Rayon thread pool on first use. On hosts with a
low container PID/thread ceiling (rootless Podman, resource-constrained VMs) this can fail
with `EAGAIN`. If you hit this, raise the limit: `podman run --pids-limit=-1 ...` or add
`pids_limit: -1` to the service in `docker-compose.yml`.

---

## Repository structure

```
mls-cli/           Rust — long-running mls-rs subprocess, one per simulated client
simulator/         TypeScript — scenario orchestration, relay, logger
analysis/          Python — log post-processing and figure generation
logs/              Runtime output (gitignored, .gitkeep tracks the directory)
figures/           Generated figures (gitignored, .gitkeep tracks the directory)
Dockerfile         Multi-stage: rust:1.85-slim builder → node:20-slim runtime
docker-compose.yml
.dockerignore      Excludes build artefacts from the Docker build context
.env.example       Copy to .env to override SEED
```

