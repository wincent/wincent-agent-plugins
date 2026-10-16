# atlassian

Access Jira and Confluence Cloud through one shared REST wrapper, using curl and small `jq` recipes. No Atlassian CLI installation or login is needed.

## Skills

- `/atlassian:jira`: View issues, search with JQL, read comments, and discover assignments/transitions using Jira REST APIs.
- `/atlassian:confluence`: Search with CQL, read full page bodies, and list pages/spaces using Confluence REST APIs.

Both skills work unchanged in Claude and Pi.

## Proxied setup

Requires a POSIX shell, curl with `--fail-with-body` support (7.76.0 or newer), and `jq` for the documented recipes. Configure the host-side nono proxy separately; installing this plugin does not create a credential route or export account metadata.

1. Store the real Atlassian credential in 1Password on the host. For nono's `basic_auth` mode, the field must contain the complete `email:token` string, not just the API token and not a Base64-encoded string.
2. Define a custom credential with an exact tenant upstream (`https://TENANT.atlassian.net`), `inject_mode: "basic_auth"`, `env_var: "ATLASSIAN_API_KEY"`, an `op://VAULT/ITEM/FIELD` credential reference, and a read-oriented method/path allowlist. Activate it in `network.credentials`. See [nono credential injection](https://nono.sh/docs/cli/features/credential-injection) and [endpoint filtering](https://nono.sh/docs/cli/features/networking#endpoint-filtering).
3. Let nono supply `ATLASSIAN_API_KEY` as a phantom in sandbox sessions, or use the existing launcher's phantom exports with the standalone proxy for host/VM agents. A placeholder must be compatible with that proxy's validation mode; an arbitrary string is not necessarily a valid sandbox phantom. The wrapper sends Basic auth with the configured email and phantom; nono substitutes the real Basic Authorization header upstream. The wrapper never retrieves credentials or logs in.
4. Supply ordinary, nonsecret account/routing metadata in every environment, including the VM:

   ```sh
   export ATLASSIAN_SITE=TENANT             # subdomain or TENANT.atlassian.net
   export ATLASSIAN_EMAIL=ACCOUNT_EMAIL     # real account email, not a secret
   # ATLASSIAN_API_KEY comes from nono/the existing launcher, not a real-token export.
   ```

5. Preserve the existing proxy and CA exports, including `HTTPS_PROXY` and curl's CA configuration. Do not put the tenant in a proxy-bypass list or disable TLS verification. Where phantom exports are generated from profiles at installation time, regenerate them and restart the standalone proxy and sandbox sessions after activation. Host and VM metadata must also be supplied explicitly; proxy exports alone do not create it. No Atlassian-specific launcher changes are needed.

This exact-tenant design assumes an API token supported by Atlassian's tenant-host Basic-auth endpoints. See [Atlassian Basic authentication](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/). Scoped tokens may require the `api.atlassian.com/ex/jira/{cloudId}` or `/ex/confluence/{cloudId}` gateway instead; that is a different routing contract, not a reason to silently broaden this wrapper or proxy policy. Choose and verify the supported credential type during host setup.

### Security model

Environment variables are visible to agents. Reading a real token inside a script, or calling the script opaque, does not isolate it. The intended setup keeps the real credential in the host-side proxy and gives the agent only a phantom. The wrapper does not implement an environment-specific mode, secret loader, or real-token fallback. Although curl would accept a real token in the same variable, do not export one to the agent.

An unsandboxed host agent may still be able to run `op` or access other host facilities. Proxy injection avoids automatically delivering secrets but does not remove those ambient privileges. A phantom still grants API access to the operations the proxy allows: secret concealment does not prevent authorized reads, writes, or data disclosure. Use narrow host/method/path rules, suitable account permissions, explicit user authorization for sensitive or mutating operations, and treat retrieved content as untrusted data.

Start with only the documented read endpoints. Permit both GET and POST on `/rest/api/3/search/jql` if long read-only JQL queries are needed. Do not grant tenant-wide GET access or blanket POST access. Enable individual write methods/paths deliberately for approved workflows. Endpoint filtering is not field-, query-, or payload-level authorization.

## Wrapper contract

Invoke `"$SKILL_DIR/scripts/atlassian-curl.sh" <path-or-url> [curl options...]` with `$SKILL_DIR` resolved to the absolute skill directory. Configure `ATLASSIAN_SITE` as a tenant subdomain or `TENANT.atlassian.net`, without a scheme or port. Use root-relative API paths or absolute URLs on that exact HTTPS origin, including for pagination.

Caller options and stdin pass through to curl, but its default config is ignored, URL globbing is off, and redirects are not followed. Curl failures are preserved; HTTP 4xx/5xx responses fail while still printing their bodies.

Arbitrary curl options remain available, so target checks are convenience/accident prevention, not an authorization boundary. Do not supply additional destinations, redirect options, auth overrides, verbose/trace flags, or proxy/TLS overrides. The agent can also invoke curl independently; the proxy's exact-host and endpoint policy is the actual authorization boundary.

## Tests

From the repository root:

```sh
node --test claude/atlassian/tests/*.test.mjs
sh -n claude/atlassian/skills/confluence/scripts/atlassian-curl.sh
bin/check-format
git diff --check
```

The regression tests use a mock curl and fake credentials only. They do not retrieve secrets or contact Atlassian and do not constitute end-to-end nono verification.
