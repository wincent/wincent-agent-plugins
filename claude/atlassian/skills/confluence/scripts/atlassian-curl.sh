#!/bin/sh
#
# atlassian-curl.sh: authenticated curl wrapper for the Atlassian Cloud
# REST API. Used by skills that need to call endpoints `acli` doesn't
# expose (notably Confluence search via CQL).
#
# Credentials are read from the environment so the API token never enters
# the agent's context window.
#
# Usage:
#     atlassian-curl.sh <path-or-url> [curl options...]
#     atlassian-curl.sh --help
#
# The first argument is either:
#   - a path beginning with "/" (appended to the configured site), e.g.
#       /wiki/rest/api/search                  Confluence
#       /rest/api/3/issue/PROJ-123             Jira
#   - a full https://… URL on *.atlassian.net.
#
# All remaining arguments are passed verbatim to curl.
#
# Required environment variables:
#   ATLASSIAN_SITE       subdomain ("acme") or full host ("acme.atlassian.net")
#   ATLASSIAN_EMAIL      email associated with the API token
#   ATLASSIAN_API_KEY    plain API token from id.atlassian.com
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
#   - Non-2xx responses cause curl to exit non-zero, but the response body
#     is still printed (via `--fail-with-body`).

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

: "${ATLASSIAN_SITE:?ATLASSIAN_SITE is not set}"
: "${ATLASSIAN_EMAIL:?ATLASSIAN_EMAIL is not set}"
: "${ATLASSIAN_API_KEY:?ATLASSIAN_API_KEY is not set}"

case $ATLASSIAN_SITE in
    http://*|https://*|*/*)
        echo "atlassian-curl: ATLASSIAN_SITE must be a host, not a URL (e.g. 'acme' or 'acme.atlassian.net', not 'https://acme.atlassian.net')" >&2
        exit 64
        ;;
    *.*) host=$ATLASSIAN_SITE ;;
    *)   host=$ATLASSIAN_SITE.atlassian.net ;;
esac

case $target in
    https://*.atlassian.net|https://*.atlassian.net/*)
        url=$target
        ;;
    https://*)
        echo "atlassian-curl: refusing non-atlassian.net URL: $target" >&2
        exit 64
        ;;
    /*)
        url=https://$host$target
        ;;
    *)
        echo "atlassian-curl: path must start with '/' or be a full https URL" >&2
        exit 64
        ;;
esac

exec curl \
    --silent --show-error --fail-with-body \
    --user "$ATLASSIAN_EMAIL:$ATLASSIAN_API_KEY" \
    --header 'Accept: application/json' \
    "$@" \
    --url "$url"
