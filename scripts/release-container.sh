#!/usr/bin/env bash
set -euo pipefail

# Use existing sudo authorization; do not grant the runner permanent docker-group access.
export DOCKER_CONFIG="$RUNNER_TEMP/intrica-docker-auth"
mkdir -p "$DOCKER_CONFIG"
chmod 700 "$DOCKER_CONFIG"
docker_ci() {
  sudo -n env DOCKER_CONFIG="$DOCKER_CONFIG" HTTP_PROXY="${HTTP_PROXY:-}" HTTPS_PROXY="${HTTPS_PROXY:-}" NO_PROXY="${NO_PROXY:-}" docker "$@"
}
scope="intrica-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
image="ghcr.io/${GITHUB_REPOSITORY,,}"
tag="${RELEASE_TAG#v}"
cleanup() {
  docker_ci rm -f "$scope-server" "$scope-postgres" >/dev/null 2>&1 || true
  docker_ci network rm "$scope" >/dev/null 2>&1 || true
  docker_ci image rm "$scope:check" "$image:$tag" >/dev/null 2>&1 || true
  docker_ci logout ghcr.io >/dev/null 2>&1 || true
  sudo -n rm -rf -- "$DOCKER_CONFIG"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker_ci build --tag "$scope:check" --build-arg "INTRICA_COMMIT=$(git rev-parse HEAD)" \
  --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY \
  --label "org.opencontainers.image.source=https://github.com/$GITHUB_REPOSITORY" .
docker_ci network create "$scope"
docker_ci run -d --name "$scope-postgres" --network "$scope" \
  -e POSTGRES_USER=intrica -e POSTGRES_PASSWORD=release -e POSTGRES_DB=intrica postgres:18
ready=false
for attempt in {1..60}; do
  if docker_ci exec "$scope-postgres" pg_isready -U intrica >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
test "$ready" = true
docker_ci run -d --name "$scope-server" --network "$scope" \
  -e "DATABASE_URL=postgres://intrica:release@$scope-postgres:5432/intrica" \
  -e DATA_DIR=/data -e INTRICA_ACCESS_TOKEN=release-check-token "$scope:check"
ready=false
for attempt in {1..60}; do
  if docker_ci exec "$scope-server" node -e "fetch('http://127.0.0.1:3001/api/v2/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then docker_ci logs "$scope-server"; exit 1; fi
docker_ci exec -e "EXPECTED_VERSION=$tag" -e "EXPECTED_COMMIT=$(git rev-parse HEAD)" "$scope-server" node --input-type=module -e \
  "const r=await fetch('http://127.0.0.1:3001/api/v2/settings/version',{headers:{Authorization:'Bearer release-check-token'}}); const v=await r.json(); if(!r.ok||v.version!==process.env.EXPECTED_VERSION||v.commit!==process.env.EXPECTED_COMMIT||v.deployment!=='container'||v.schemaVersion!==12) process.exit(1)"
printf '%s' "$GH_TOKEN" | docker_ci login ghcr.io --username "$GITHUB_ACTOR" --password-stdin
docker_ci tag "$scope:check" "$image:$tag"
# The push receipt is the registry's digest; local RepoDigests may start with a temporary tag.
docker_ci push "$image:$tag" | tee "$RUNNER_TEMP/intrica-container-push.log"
digest=$(awk -v tag="$tag:" '$1==tag && $2=="digest:" { print $3 }' "$RUNNER_TEMP/intrica-container-push.log" | tail -n 1)
[[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]
docker_ci logout ghcr.io
if ! docker_ci pull "$image@$digest"; then
  echo 'The published image must allow anonymous pulls. Set the GHCR package visibility to public.' >&2
  exit 1
fi
echo "image=$image@$digest" >> "$GITHUB_OUTPUT"
