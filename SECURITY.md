# Security Policy

This document outlines the security posture, known risk areas, and practical mitigations for using `beacon-opencode` safely.

## Why this matters (supply chain context)

Recent ecosystem incidents (2024–2026) highlight elevated package and model supply-chain risk:

- **Axios compromise (March 2026)**: attacker gained maintainer access and published a malicious version containing a cross-platform RAT, impacting 50M+ weekly downloads.
- **Malicious postinstall campaigns (2025)**: hundreds of npm packages shipped obfuscated `postinstall` scripts exfiltrating `.env` files and cloud credentials.
- **HuggingFace model poisoning (2025)**: malicious model uploads with embedded execution payloads.
- **Dependency confusion attacks**: attackers publish packages matching internal names on public registries.

`beacon-opencode` executes in developer environments with repository filesystem access, so cautious install/upgrade practices are strongly recommended.

---

## Risk areas specific to this plugin

1. **`postinstall` script** (`scripts/setup.cjs`)
   - Runs during install with filesystem access.
2. **ONNX model downloads** via `download-model`
   - Downloads from HuggingFace; current implementation does **not** verify checksums automatically.
3. **Native dependencies** (`hnswlib-node`, `onnxruntime-node`)
   - Native compiled code executes at runtime.
4. **Editor context execution**
   - Plugin runs inside OpenCode with full access to your working project files.

---

## End-user mitigations (ranked by impact)

1. **Verify npm provenance** *(Easy / High impact)*
   - Check provenance attestation on npmjs.com before installing/upgrading.
   - Prefer packages with verified GitHub Actions build provenance links.

2. **Pin exact version** *(Easy / High impact)*
   - Use exact dependency versions, for example:
   - `"beacon-opencode": "2.1.0"`
   - Avoid ranges like `^2.1.0` for security-sensitive environments.

3. **Audit before upgrading** *(Easy / High impact)*
   - Run `npm audit` and inspect package diffs/changelog before updating.

4. **Verify model checksums** *(Medium / High impact)*
   - After `download-model`, verify downloaded ONNX files against known SHA-256 values published in project releases.

5. **Review postinstall behavior** *(Easy / Medium impact)*
   - `scripts/setup.cjs` is public and auditable.
   - Current behavior: creates `.opencode/beacon.json` (if missing) and local plugin directories; no network calls or exfiltration logic.

6. **Use lockfiles** *(Easy / Medium impact)*
   - Commit `bun.lock` or `package-lock.json`.
   - In CI, use deterministic installs (`bun install --frozen-lockfile`).

7. **Use network isolation when possible** *(Medium / Medium impact)*
   - With local ONNX mode (`api_base: "local"`), normal search/index operations make zero network calls.
   - Outbound calls are only needed for `download-model` (to `huggingface.co`).

---

## Maintainer security practices

Current:
- ✅ Published with npm provenance (Sigstore attestation via GitHub Actions)
- ✅ GitHub Actions workflows use minimal permissions
- ✅ Dependencies pinned in `bun.lock`
- ✅ `postinstall` script is minimal and auditable (no network calls)
- ✅ CI runs `npm audit` on every push

Planned improvements:
- ⚠️ ONNX model SHA-256 verification in downloader (future release)
- ⚠️ Pin GitHub Actions by full action SHA (future hardening)

---

## Reporting vulnerabilities

Please **do not** open public issues for security vulnerabilities.

Use GitHub's **private vulnerability reporting** for this repository to disclose issues directly to the maintainer.

