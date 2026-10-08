# OCR through nono

A Pi `ocr` tool for local PDFs and PNG/JPEG images, using Mistral's OCR API through an existing nono credential proxy. The extension never reads `MISTRAL_API_KEY`, runs a credential helper, or accepts a real API key. It always sends the placeholder `Authorization: Bearer proxied`; the host-side proxy substitutes the real credential.

## Setup

Requires Pi, `curl`, and a proxy-enabled session with `HTTPS_PROXY` (or `https_proxy`) and a readable proxy CA bundle (`CURL_CA_BUNDLE`, `SSL_CERT_FILE`, or `NODE_EXTRA_CA_CERTS`, in that order). The proxy URL must be HTTP on loopback. Both a local nono sandbox proxy and a host proxy forwarded into a VM can work. No SDK or additional npm dependencies are needed.

1. In a trusted host environment, create a Mistral API key and store it in 1Password. The example expects `op://CLI/mistral-api-key/credential`; adjust that reference to match your item. Do not paste the key into Pi, a shell command visible to the agent, or the configuration file.
2. If your installed profile already includes the built-in `mistral_ocr` route from the wincent dotfiles, no extra route is needed; do not add a duplicate private entry. Otherwise merge the `credentials.mistral_ocr` entry from [`nono.example.json`](nono.example.json) into your private `NONO_PROXY_CONFIG` JSON. Preserve existing credentials and capture definitions. If you have no private routes yet, copy the example to a private host configuration file and point `NONO_PROXY_CONFIG` at that file from your private shell configuration. The example contains only a credential reference, never the key.
3. After changing proxy configuration, run `./install dotfiles` from a trusted host shell in the wincent dotfiles checkout, then `nono profile validate pi`. Start a new proxy-enabled Pi session so the new profile and CA exports are inherited. The generation-aware wrappers select a new proxy automatically; `/reload` alone cannot update an existing session's proxy policy. Image support uses the same endpoint and credential as PDF support: if PDF OCR already works, just reload the updated extension, with no proxy or dotfiles changes.
4. If Pi already loads this repository's `pi/extensions` and `pi/skills` directories, discovery is automatic. Otherwise add those directories to Pi's resources or load this directory with `pi -e /absolute/path/to/pi/extensions/ocr`. Run `/ocr-status` to check local configuration; this command does not read the key or verify the live route.
5. Ask Pi to OCR the first page of an approved PDF, or an approved PNG/JPEG image. Review the upload confirmation. Every request uploads the entire file, including embedded metadata and, for PDFs, unselected pages. API charges and Mistral's data-handling terms apply.

The example uses an explicit `endpoint_policy` with a default deny and a single allowed operation: `POST https://api.mistral.ai/v1/ocr`. This is intentional: in nono 0.79.0, legacy credential `endpoint_rules` can let unmatched requests pass through without injecting a credential, whereas the explicit policy rejects them. This also means this route can conflict with other intended Mistral operations on the same host; review the combined policy before adding chat or Files API access.

## Usage and limits

Conceptual tool call:

```json
{"path": "book.pdf", "pages": [0, 4, 19]}
```

For an image, use `{"path": "scan.png"}` (JPEG/JPG works too). Images are sent as Base64 `image_url` inputs; PDFs retain the `document_url` input format. Both use `POST /v1/ocr`.

- Omit `pages` to process only PDF page 1 (`[0]`), or the entire single image. Images accept only omission or `[0]`; other page selections are rejected before approval or upload. The API request omits PDF page-selection options for images, and image output is tracked as index 0. There is deliberately no implicit whole-book operation.
- Select 1-25 unique zero-based PDF page indices, each between 0 and 999. These are not printed page numbers. The prototype does not parse PDF page counts; Mistral validates the actual document, and missing requested pages are reported as warnings.
- Input must be a readable regular file with a PDF, PNG, or JPEG signature, at most 20 MiB. Format is detected from the bytes, not the filename or extension. This is a format sanity check, not a full document validator or image decoder. Other formats (including GIF, WebP, TIFF, HEIC, and SVG) are not supported by this adapter. Local file reads have only the agent's own privileges; this is not a privileged file broker.
- The file is read into a bounded in-memory snapshot before confirmation. The exact approved bytes are sent even if the file changes while the dialog is open. Images are not resized, recompressed, or stripped of metadata; crop/redact or remove metadata locally before OCR if needed.
- The default model is `mistral-ocr-latest`. Optionally set `MISTRAL_OCR_MODEL` to an available versioned `mistral-ocr-*` model in the launch environment. The tool cannot choose arbitrary models. The manifest records both the requested and returned model strings; a returned alias is not proof of a resolved version.
- At most one OCR call runs per extension instance. Requests time out after 180 seconds, responses are bounded at 32 MiB, and automatic retries are disabled. Cancellation or a connection failure does not prove that processing or billing was cancelled. Never automatically repeat an uncertain request.
- Each call needs Pi UI confirmation. Headless/print calls fail closed; RPC works only if its UI client supports confirmation. Subagents without a confirmation-capable UI should delegate OCR to the interactive parent.
- No remote document URLs, Files API, extracted image downloads, searchable PDF generation, preprocessing, or batch API in this prototype. Split a document locally first if only selected pages may leave the machine.

## Artifacts and privacy

A fresh `ocr-*` directory is reserved under the working directory before upload. It contains `response.json` (the original successful API response), `document.md` (Markdown with explicit PDF page or image markers), and `manifest.json` (source path/hash/size, detected media type, page selection, model strings, timestamp, and warnings). Files use mode `0600`; the directory uses `0700`. Existing artifacts are never overwritten. Results return artifact links and a short summary, not the extracted document text.

The client uses curl with its startup configuration disabled, an explicit proxy and CA, redirects disabled, and a minimal child environment. The proxy URL/password is supplied through stdin, not command arguments. Base64 request data is briefly spooled to a private temporary directory and removed in normal success, failure, and cancellation paths. A process crash or machine shutdown can leave that private temporary data behind; cleanup is not secure erasure. Artifacts remain until you remove them, and may be captured by filesystem backups or accidentally added to version control. There is no separate Files API upload to clean up remotely, but inline requests remain subject to Mistral's retention policy.

Curl diagnostics and upstream error bodies are suppressed. The extension never dumps request headers, Base64 documents, or credentials into the transcript. OCR Markdown and the raw JSON are untrusted document content; embedded instructions must not be followed. The raw HTTP-200 response is saved before schema validation so a changed API schema does not discard a paid result. If validation or artifact writing fails, preserve and inspect partial results rather than repeating a paid call.

## Security boundary

The extension is a workflow adapter, not a security boundary. Key isolation depends on running the agent in a sandbox/VM that cannot read host secrets, invoke host credential helpers, inspect the credential-bearing process, or modify trusted proxy policy/helpers. Unsandboxed same-user Pi does not provide that guarantee, even when it normally uses a phantom credential. Loopback/proxy/CA checks do not attest that the proxy is nono or that its policy is correct.

An agent with shell access can call the allowed OCR endpoint without using this extension. UI approval, page/model limits, and the concurrency guard are not enforceable spending or disclosure controls against such an agent. Use provider-side limits where available, or a trusted narrow broker, for hard quotas and mandatory per-document approval. Proxy-access credentials still grant proxy capabilities and must not be published; only the Mistral key stays exclusively in the trusted host process.

## Tests

From the plugin repository root:

```sh
# For the dotfiles-managed Pi (omit for a normal global npm installation):
export PI_TEST_PACKAGE_DIR="$HOME/n/pi/node_modules/@earendil-works/pi-coding-agent"
node --experimental-transform-types --test pi/extensions/tests/ocr.test.mjs
NONO_PROXY_INTEGRATION=1 node --experimental-transform-types --test pi/extensions/tests/ocr-nono.test.mjs
bin/typecheck
```

The ordinary tests use fake curl and synthetic PDF/image data; they make no provider requests. They cover format sniffing, image request payloads, single-page restrictions, immutable approval snapshots, image artifacts, and the existing PDF/security/recovery behavior. These tests do not measure live OCR accuracy or decode the image fixtures. The opt-in integration test requires `nono`, `openssl`, `curl`, and permission to bind loopback sockets. It uses the example route with a disposable key and local HTTPS upstream, verifying Bearer substitution, explicit method/path rejection, different-host credential isolation, proxy authentication, and CA validation. It never reads 1Password, restarts your normal proxy, or contacts Mistral. Verified against nono 0.79.0; real-account and VM activation are separate checks.
