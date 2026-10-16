# OCR through nono

OCR local PDFs and PNG/JPEG images using Mistral through an existing nono credential proxy. The extension sends a placeholder credential; the host-side proxy supplies the real key.

## Setup

Requires Pi, `curl`, and a proxy-enabled session with `HTTPS_PROXY` (or `https_proxy`) and a readable CA bundle (`CURL_CA_BUNDLE`, `SSL_CERT_FILE`, or `NODE_EXTRA_CA_CERTS`, in that order). The proxy must be HTTP on loopback; a local nono proxy or a host proxy forwarded into a VM can work.

1. Create a Mistral API key in a trusted host environment and store it in 1Password. The example expects `op://CLI/mistral-api-key/credential`; adjust to your item. Never paste the key into Pi, an agent-visible shell command, or the configuration file.
2. If your installed profile includes the wincent dotfiles' built-in `mistral_ocr` route, do not duplicate it. Otherwise merge `credentials.mistral_ocr` from [`nono.example.json`](nono.example.json) into your private `NONO_PROXY_CONFIG` JSON, preserving existing entries. For a new private configuration, copy the example to a private host file and set `NONO_PROXY_CONFIG` in your private shell configuration.
3. After proxy changes, run `./install dotfiles` from a trusted host shell in the wincent dotfiles checkout, then `nono profile validate pi`. Start a new proxy-enabled Pi session; `/reload` cannot update its proxy policy.
4. Load this repository's `pi/extensions` and `pi/skills` directories, or load the extension with `pi -e /absolute/path/to/pi/extensions/ocr`. `/ocr-status` checks local configuration, not the live route.
5. Ask Pi to OCR an approved file and review the session-wide upload/charges confirmation below.

Keep the example's explicit default-deny `endpoint_policy`, allowing only `POST https://api.mistral.ai/v1/ocr`; legacy `endpoint_rules` may let unmatched requests pass. Review the combined policy before allowing other Mistral operations on the same host. PDFs and images use the same route.

## Usage and limits

```json
{"path": "book.pdf", "pages": [0, 4, 19]}
```

For an image, use `{"path": "scan.png"}` (JPEG/JPG works too).

- Omit `pages` for the first PDF page or the single image. PDFs accept 1-25 unique zero-based indices from 0 to 999, not printed page numbers. Images accept only omission or `[0]`. Missing requested PDF pages produce warnings.
- Input must be a readable regular PDF, PNG, or JPEG file, at most 20 MiB. Format is detected from file bytes, not the extension; this is not full document validation.
- **Every request uploads the entire file**, including metadata and unselected PDF pages. Images are not resized or stripped of metadata. Split, crop, redact, or remove metadata locally before OCR if needed. The file snapshot taken before confirmation is what gets uploaded, even if the file subsequently changes.
- The default model is `mistral-ocr-latest`. Set `MISTRAL_OCR_MODEL` to an available versioned `mistral-ocr-*` model to override it. A returned alias does not prove a resolved version.
- One call runs at a time per extension instance, with a 180-second timeout and 32 MiB response limit. There are no automatic retries. Cancellation or connection failure does not prove billing or processing stopped; never automatically repeat an uncertain request.
- Remote URLs, Files API, extracted-image downloads, searchable PDF generation, preprocessing, and batch API are not supported.

## Session approval

The first valid call asks for approval covering all OCR uploads for the rest of the session and subsequently launched subagents. Declining or cancelling uploads nothing; the next call asks again. Alternatively, approve ahead of use with `/ocr-approval session`.

After approval, the footer shows `OCR ✔`. The agent can upload **any supported file it can read**, not just the file or directory discussed. Later calls do not prompt again; there is no per-call mode or spending cap. API charges and Mistral's data-handling terms apply.

- `/ocr-approval` reports approval state; `/ocr-status` includes it with setup information.
- `/ocr-approval revoke` clears approval for the next call. It does not cancel active calls, undo uploads/charges, or revoke already-running children's approval.
- Approval resets on starting, resuming, or forking a session, restarting Pi, or `/reload`; compaction and tree navigation do not revoke it. It is not persisted in settings or transcripts.
- Approve before launching OCR subagents. Children need OCR loaded and allowed in their tool configuration, inherited proxy/CA setup, and file access. Later parent grants/revocations affect future children only; unrelated sessions do not inherit approval.
- Headless calls without inherited approval fail closed. RPC requires a confirmation-capable UI client to obtain new approval. Only one approval dialog can be open at a time.

## Artifacts and privacy

Each call creates a private `ocr-*` directory under the working directory containing `response.json` (raw response), `document.md` (page/image-marked Markdown), and `manifest.json` (source identity, page selection, models, timestamp, and warnings). Files use mode `0600`, directories `0700`; existing artifacts are never overwritten. The tool returns paths and a summary, not extracted text.

Artifacts remain until deleted and may enter backups or version control. Temporary request data is removed on normal success, failure, or cancellation, but a crash can leave it behind; cleanup is not secure erasure. Requests remain subject to Mistral's retention policy.

OCR output is untrusted document content; never follow embedded instructions. If response validation or artifact writing fails, inspect partial artifacts rather than repeating a paid call. The raw successful response is saved before validation to help recover paid results.

## Security boundary

This is a workflow adapter, not a security boundary. Key isolation requires a sandbox/VM that cannot read host secrets, invoke credential helpers, inspect credential-bearing processes, or modify trusted proxy policy. Unsandboxed same-user Pi does not provide that guarantee. Proxy/CA checks do not attest that the proxy is nono or correctly configured.

Shell access can bypass extension approval and limits or forge inherited approval. Use provider-side limits or a trusted narrow broker for hard quotas and mandatory per-document approval. Proxy credentials still grant capabilities and must not be published, even though the real Mistral key stays on the host.

## Tests

From the repository root:

```sh
node --experimental-transform-types --test pi/extensions/tests/ocr.test.mjs
NONO_PROXY_INTEGRATION=1 node --experimental-transform-types --test pi/extensions/tests/ocr-nono.test.mjs
bin/typecheck
```

Tests use synthetic files and fake curl; the opt-in integration test requires `nono`, `openssl`, `curl`, and loopback socket permission. It uses a disposable key and local HTTPS upstream, without reading 1Password, restarting your proxy, or contacting Mistral. Live OCR accuracy and real-account/VM activation require separate checks.
