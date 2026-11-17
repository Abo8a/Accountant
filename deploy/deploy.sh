#!/usr/bin/env bash
# Деплой на сервере: обновить код из main, пересобрать образы из исходников и поднять стек.
# Запуск из клона на сервере:  ./deploy/deploy.sh
# Нужен файл .env в корне клона (его на сервер кладёт владелец вручную, в git его нет).
set -Eeuo pipefail

cd "$(dirname "$0")/.."

log() { printf '\n==> %s\n' "$*"; }

[ -f .env ] || { echo "Нет файла .env в $(pwd). Положите его туда и запустите снова." >&2; exit 1; }

log "Код: обновление из origin/main"
git fetch --prune origin main
git checkout -q main
git pull --ff-only origin main
echo "Коммит: $(git rev-parse --short HEAD)"

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.server.yml --profile prod)

log "Сборка образов из исходников"
"${COMPOSE[@]}" build

log "Запуск стека (compose ждёт healthcheck)"
"${COMPOSE[@]}" up -d --wait --wait-timeout 600 --remove-orphans
"${COMPOSE[@]}" ps

log "Проверка сайта"
SITE_DOMAIN="$(grep -E '^SITE_DOMAIN=' .env | head -1 | cut -d= -f2- | tr -d '\r')"
curl --fail --silent --show-error --max-time 30 "https://${SITE_DOMAIN}/" > /dev/null
echo "OK: https://${SITE_DOMAIN}/"
