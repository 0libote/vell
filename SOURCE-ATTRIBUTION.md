# Source Attribution — Vell

Vell is an independent product. Its initial desktop foundation was imported
as a clean source snapshot (no Git history) from Voxden.

- Upstream repository: https://github.com/sounak1125/voxden
- Imported commit SHA: `2d567bcc584453b3a8fb16a9bba874eb3b268094`
- Imported date (upstream commit): 2026-10-21
- Import method: downloaded source ZIP for the commit
  (`https://github.com/sounak1125/voxden/archive/2d567bcc584453b3a8fb16a9bba874eb3b268094.zip`),
  extracted to a temporary directory, and copied into this repository.
- Git history was intentionally NOT imported (`git clone` / fork not used).
  Vell history starts fresh from this snapshot.
- No upstream Git remote is configured in this repository.
- Excluded from import: `.git/` metadata (not present in ZIP), `node_modules/`,
  `dist/`, model downloads, runtime caches, and other generated artefacts
  listed in upstream `.gitignore`. No release binaries are shipped in the ZIP.
- Preserved: upstream `THIRD_PARTY_NOTICES.md`, MIT `license: MIT` declaration
  in `package.json`, and third-party copyright notices in source/build assets.
  These must be retained in distributions that include the corresponding code.
- Pre-existing workspace scaffold files overwritten by the snapshot
  (backed up before import):
  - `README.md` (T3 placeholder) → replaced by upstream README (to be
    replaced by Vell README during rebrand).
  - `assets/icon.svg` (Vell pink “V” placeholder) → replaced by upstream
    icon (to be restored as temporary Vell branding during rebrand).
    Original Vell placeholder backed up at `/tmp/vell-backup/icon.vell.svg`
    during import; re-applied in the rebrand commit.

## Desert Ant Labs (future model backend, not yet integrated)

- SDK repo: https://github.com/Desert-Ant-Labs/desert-ant-core
- Voz docs: https://github.com/Desert-Ant-Labs/desert-ant-core/blob/main/docs/models/voz.md
- Licence: https://license.desertant.com/1.0 (Desert Ant Labs Source-Available
  License v1.0 — free below 100,000 monthly active devices per platform per
  model; attribution required; minimal MAD-counting telemetry must not be
  disabled; see `docs/DESERT-ANT.md` once created).

This file satisfies Phase 1 §8 (record upstream URL + SHA).
