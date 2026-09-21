#!/bin/bash

set -euo pipefail

if [[ -z "${IMGFLIP_USERNAME:-}" || -z "${IMGFLIP_PASSWORD:-}" ]]; then
    echo '{"success":false,"error_message":"IMGFLIP_USERNAME and IMGFLIP_PASSWORD environment variables must be set. Create a free account at https://imgflip.com/signup"}'
    exit 1
fi

template_id="$1"
shift

args=(
    -s -X POST https://api.imgflip.com/caption_image
    --data-urlencode "template_id=$template_id"
    --data-urlencode "username=$IMGFLIP_USERNAME"
    --data-urlencode "password=$IMGFLIP_PASSWORD"
)

i=0
for text in "$@"; do
    args+=(--data-urlencode "boxes[$i][text]=$text")
    ((++i))
done

curl "${args[@]}"
