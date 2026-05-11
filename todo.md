# TODO

## Reader Image Candidate Ordering

Current state: server generates 25 direct store candidates per page and randomizes their order so we can collect store-quality observations.

Later, after enough logs exist:

- Disable random candidate ordering.
- Replace it with smart deterministic ordering so repeated reads hit browser/HTTP cache more often.
- Use `image_store_status` observations to choose order:
  - known-good hosts first
  - recently failed hosts last
  - canonical host preference if evidence supports it
  - stable ordering per canonical image/path to preserve cache locality
- Keep fallback behavior: frontend still tries candidates until one succeeds.
- Keep logging compact enough to verify host quality and cache behavior.
