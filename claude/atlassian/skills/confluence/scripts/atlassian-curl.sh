#!/bin/sh
#
# atlassian-curl.sh: authenticated curl wrapper for the Atlassian Cloud
# REST API. Shared by the Jira and Confluence skills.
#
# ATLASSIAN_API_KEY should be a nono phantom; the host-side proxy supplies
# the real Basic credentials. Environment variables are visible to agents.
#
# Usage:
#     atlassian-curl.sh <path-or-url> [curl options...]
#     atlassian-curl.sh --help
#
# The first argument is either:
#   - a path beginning with "/" (appended to the configured site), e.g.
#       /wiki/rest/api/search                  Confluence
#       /rest/api/3/issue/PROJ-123             Jira
#   - an HTTPS URL on the exact configured host, without userinfo or ports.
#
# All remaining arguments are passed verbatim to curl. This wrapper is not
# an authorization boundary: the proxy must enforce host/endpoint policy.
# Do not supply extra destinations, redirects, auth, proxy/TLS overrides,
# or tracing options. Curl's default config and URL globbing are disabled.
#
# Required environment variables:
#   ATLASSIAN_SITE       subdomain ("acme") or full host ("acme.atlassian.net")
#   ATLASSIAN_EMAIL      email associated with the API token
#   ATLASSIAN_API_KEY    phantom supplied by nono or the existing launcher
#
# Examples:
#   atlassian-curl.sh /wiki/rest/api/search \
#       --get \
#       --data-urlencode 'cql=type = page AND text ~ "deploy"' \
#       --data-urlencode 'limit=10'
#
#   atlassian-curl.sh /rest/api/3/issue/PROJ-123
#
# Caveats:
#   - Do NOT pass `-v` / `--verbose`: that would print the Authorization
#     header (and therefore the base64-encoded token) to stderr.
#   - HTTP 4xx/5xx responses cause curl to exit non-zero, but the response
#     body is still printed (via `--fail-with-body`). Redirects are not followed.

# Defensively disable shell tracing even if the parent invoked us with
# `sh -x`: we don't want the credential-bearing argv to be echoed.
set +x
set -eu

usage() {
    awk 'NR == 1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"
}

case "${1:-}" in
    -h|--help)
        usage
        exit 0
        ;;
    "")
        usage >&2
        exit 64
        ;;
esac

target=$1
shift

: "${ATLASSIAN_SITE:?Set ATLASSIAN_SITE to the tenant subdomain or host in the host/VM environment}"
: "${ATLASSIAN_EMAIL:?Set ATLASSIAN_EMAIL to the account email in the host/VM environment}"
: "${ATLASSIAN_API_KEY:?ATLASSIAN_API_KEY is missing; ask the user to configure nono and restart the proxy/session for a phantom}"

# A single DNS label, optionally followed by .atlassian.net. Do not accept
# arbitrary hosts, URL syntax, ports, or curl glob patterns in configuration.
site=${ATLASSIAN_SITE%.atlassian.net}
case $site in
    ""|*[!a-zA-Z0-9-]*|-*|*-)
        echo "atlassian-curl: ATLASSIAN_SITE must be a tenant subdomain or tenant.atlassian.net host (no URL or port)" >&2
        exit 64
        ;;
esac
if [ "${#site}" -gt 63 ]; then
    echo "atlassian-curl: ATLASSIAN_SITE tenant label is too long" >&2
    exit 64
fi
origin=https://$site.atlassian.net

case $target in
    "$origin") target=/ ;;
    "$origin/"*) target=${target#"$origin"} ;;
    "$origin?"*) target=/${target#"$origin"} ;;
esac
case $target in
    *[[:space:][:cntrl:]]*|*\\*|*\#*|//*)
        echo "atlassian-curl: invalid target; use an encoded API path without whitespace, backslashes, fragments, or a network-path reference" >&2
        exit 64
        ;;
    /*) url=$origin$target ;;
    *)
        echo "atlassian-curl: use an API path starting with '/' or the exact configured HTTPS origin (no userinfo or port)" >&2
        exit 64
        ;;
esac

# --disable must be first: a curlrc could otherwise add redirects or URLs.
# Leave the proxy and CA environment supplied by nono untouched.
exec curl --disable \
    --silent --show-error --fail-with-body --globoff --basic \
    --user "$ATLASSIAN_EMAIL:$ATLASSIAN_API_KEY" \
    --header 'Accept: application/json' \
    "$@" \
    --url "$url"
