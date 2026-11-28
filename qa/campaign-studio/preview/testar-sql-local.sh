#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.."
export DOCKER_HOST="${DOCKER_HOST:-unix:///var/run/docker.sock}"
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH
if [[ "$DOCKER_HOST" != unix:///* || ! -S "${DOCKER_HOST#unix://}" ]]; then
  printf '%s\n' 'Use um daemon Docker local acessível por socket Unix.' >&2
  exit 1
fi

container=$(docker run --detach --rm --pull never --network none \
  --env POSTGRES_HOST_AUTH_METHOD=trust postgres:17-bookworm \
  postgres -c listen_addresses='')
trap 'docker stop "$container" >/dev/null' EXIT

for attempt in {1..40}; do
  if docker exec "$container" sh -c 'test "$(cat /proc/1/comm)" = postgres && pg_isready -q -U postgres'; then break; fi
  if [[ "$attempt" = 40 ]]; then printf '%s\n' 'PostgreSQL local indisponível.' >&2; exit 1; fi
  sleep 0.25
done

sql() {
  local db=$1
  local file=$2
  shift 2
  docker exec -i "$container" psql -X -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@" < "$file"
}

sources=migrations/campaign-studio
qa=qa/campaign-studio
preview="$qa/preview"
databases=(lltouch_authorization_qa lltouch_crm_qa lltouch_mapped_qa)
for db in "${databases[@]}"; do
  docker exec "$container" createdb -U postgres "$db"
  sql "$db" "$qa/fixtures/local-schema.sql" -q
  sql "$db" "$sources/05c-00-mapped-baseline.sql" -q
  [[ "$(sql "$db" "$sources/verify/05c-00-mapped-baseline.sql" -Atq)" = 'VERIFIED|||t|t' ]]
  if [[ "$db" = lltouch_mapped_qa ]]; then
    sql "$db" "$preview/01_PREFLIGHT_PREVIEW.sql" -Atq
  fi
  for migration in "$sources"/05c-0[123]-*.sql; do sql "$db" "$migration" -q; done
  sql "$db" "$preview/03_VERIFICAR_FUNCOES_PREVIEW.sql" -Atq
done

sql lltouch_authorization_qa "$qa/05c-authorization.test.sql" -q
sql lltouch_crm_qa "$qa/05c-ghl-effects.test.sql" -q
sql lltouch_mapped_qa "$qa/mapped-lifecycle.integration.sql" -q
LL_CM_TEST_PG_CONTAINER="$container" node "$qa/05c-authorization-concurrency.integration.mjs"
LL_CM_TEST_PG_CONTAINER="$container" node "$qa/05d-booking-concurrency.integration.mjs"

sql lltouch_mapped_qa "$preview/01_PREFLIGHT_PREVIEW.sql" -Atq
for db in "${databases[@]}"; do
  [[ "$(sql "$db" "$preview/06_VERIFICACAO_FINAL_PREVIEW.sql" -Atq)" = 'VERIFIED|0|0|0|0|0|0|0' ]]
done
printf '%s\n' 'PASS · Verificação final sem publicações, autorizações, auditorias ou filas sintéticas residuais.'

# Preserve the mapped baseline in this exercise, as the PREVIEW already has it.
for version in 03 02 01; do
  for rollback in "$sources"/rollback/05c-"$version"-*.sql; do sql lltouch_mapped_qa "$rollback" -q; done
done
[[ "$(sql lltouch_mapped_qa "$sources/verify/05c-00-mapped-baseline.sql" -Atq)" = 'VERIFIED|||t|t' ]]
printf '%s\n' 'PASS · Rollback das candidatas sem uso com baseline mapeado preservado.'
