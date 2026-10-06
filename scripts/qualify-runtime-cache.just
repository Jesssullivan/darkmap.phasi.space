# Invoke only inside the root producer's admitted locked Nix shell.
# A delivery helper: do not copy it into/rebuild the application to run one test.
set shell := ["bash", "-euo", "pipefail", "-c"]

qualify app_root expected_source_sha:
    #!/usr/bin/env bash
    set -euo pipefail
    cd '{{ app_root }}'
    expected='{{ expected_source_sha }}'
    [[ "$expected" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected full app source SHA' >&2; exit 2; }
    [[ "$(git rev-parse HEAD)" == "$expected" ]] || { echo 'Qualification source mismatch' >&2; exit 2; }
    [[ -z "$(git status --porcelain)" ]] || { echo 'Qualification checkout must be clean' >&2; exit 2; }
    bazelisk test --test_strategy=standalone //src/lib/sw:sw_test
