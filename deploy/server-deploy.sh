#!/usr/bin/env bash
set -euo pipefail

release=${1:?Provide the release directory}
[[ "$release" =~ ^/opt/telegrambot/releases/[0-9a-f]{40}$ ]] || { echo 'Invalid release path'; exit 1; }
test -f /opt/telegrambot/shared/.env || { echo 'Create /opt/telegrambot/shared/.env with ADMIN_PASSWORD before deployment.'; exit 1; }
command -v docker >/dev/null
docker compose version >/dev/null
install -d -m 700 -o 1000 -g 1000 /opt/telegrambot/shared/data

revision=${release##*/}
export DEPLOY_IMAGE="telegrambot:$revision"
compose=(docker compose --project-name telegrambot -f "$release/deploy/compose.yaml")
previous=$(readlink /opt/telegrambot/current || true)
previous_image=''
if [[ "$previous" =~ ^/opt/telegrambot/releases/[0-9a-f]{40}$ ]]; then
  previous_image="telegrambot:${previous##*/}"
fi

# Build before stopping the live bot. Never run two pollers together.
docker build --tag "$DEPLOY_IMAGE" "$release"
"${compose[@]}" stop --timeout 240
if "${compose[@]}" up -d --wait --wait-timeout 120; then
  ln -sfn "$release" /opt/telegrambot/current.next
  mv -Tf /opt/telegrambot/current.next /opt/telegrambot/current
  echo "Deployed $revision"
else
  echo 'New deployment failed its health check.' >&2
  "${compose[@]}" logs --tail 40 >&2
  if [[ -n "$previous_image" ]] && docker image inspect "$previous_image" >/dev/null 2>&1; then
    DEPLOY_IMAGE="$previous_image" docker compose --project-name telegrambot -f "$previous/deploy/compose.yaml" up -d --wait --wait-timeout 120
    echo 'Restored previous image.' >&2
  fi
  exit 1
fi
