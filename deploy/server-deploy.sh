#!/usr/bin/env bash
set -euo pipefail

release=${1:?Provide the release directory}
[[ "$release" =~ ^/opt/telegrambot/releases/[0-9a-f]{40}$ ]] || { echo 'Invalid release path'; exit 1; }
exec 9>/opt/telegrambot/deploy.lock
flock -w 180 9
test -f /opt/telegrambot/shared/.env || { echo 'Create /opt/telegrambot/shared/.env with ADMIN_PASSWORD before deployment.'; exit 1; }
command -v docker >/dev/null
docker compose version >/dev/null
if [[ "$(readlink /opt/telegrambot/current || true)" == "$release" &&
      "$(docker inspect telegrambot-app-1 --format '{{.State.Health.Status}}' 2>/dev/null || true)" == healthy ]]; then
  echo 'Release is already active and healthy.'
  exit 0
fi
install -d -m 700 -o 1000 -g 1000 /opt/telegrambot/shared/data

revision=${release##*/}
export DEPLOY_IMAGE="telegrambot:$revision"
base_image=telegrambot:e8aae63d1b9c844d2029d572b7f12ac63b81226a
compose=(docker compose --project-name telegrambot -f "$release/deploy/compose.yaml")
previous=$(readlink /opt/telegrambot/current || true)
previous_image=''
if [[ "$previous" =~ ^/opt/telegrambot/releases/[0-9a-f]{40}$ ]]; then
  previous_image="telegrambot:${previous##*/}"
fi

# Build on the server using the small existing base image when available.
if ! docker image inspect "$DEPLOY_IMAGE" >/dev/null 2>&1; then
  if docker image inspect "$base_image" >/dev/null 2>&1 && test -f "$release/dist/public/index.html"; then
    docker build --file "$release/deploy/overlay.Dockerfile" --tag "$DEPLOY_IMAGE" "$release"
  else
    docker build --tag "$DEPLOY_IMAGE" "$release"
  fi
fi
"${compose[@]}" stop --timeout 1
if "${compose[@]}" up -d --wait --wait-timeout 120; then
  ln -sfn "$release" /opt/telegrambot/current.next
  mv -Tf /opt/telegrambot/current.next /opt/telegrambot/current
  echo "Deployed $revision"

  # Keep the active release, one rollback and the image required by overlay builds.
  while IFS= read -r image; do
    case "$image" in
      telegrambot:*)
        if [[ "$image" != "$DEPLOY_IMAGE" && "$image" != "$previous_image" && "$image" != "$base_image" ]]; then
          docker image rm "$image" >/dev/null || echo "Could not remove unused image $image" >&2
        fi
        ;;
    esac
  done < <(docker image ls --format '{{.Repository}}:{{.Tag}}')
  for old_release in /opt/telegrambot/releases/*; do
    if [[ "$old_release" =~ ^/opt/telegrambot/releases/[0-9a-f]{40}$ && -d "$old_release" && "$old_release" != "$release" && "$old_release" != "$previous" ]]; then
      rm -rf -- "$old_release"
    fi
  done
  # Reclaim build cache and dangling layers after every healthy deployment.
  docker builder prune --all --force >/dev/null || echo 'Could not prune Docker build cache.' >&2
  docker image prune --force >/dev/null || echo 'Could not prune dangling images.' >&2
else
  echo 'New deployment failed its health check.' >&2
  "${compose[@]}" logs --tail 40 >&2
  if [[ -n "$previous_image" ]] && docker image inspect "$previous_image" >/dev/null 2>&1; then
    DEPLOY_IMAGE="$previous_image" docker compose --project-name telegrambot -f "$previous/deploy/compose.yaml" up -d --wait --wait-timeout 120
    echo 'Restored previous image.' >&2
  fi
  exit 1
fi
