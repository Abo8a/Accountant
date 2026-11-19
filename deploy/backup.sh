#!/bin/sh
# Резервные копии: дамп Postgres и архив тома загрузок (материалы проектов). Одна копия = два файла с общей отметкой времени:
#   db-<UTC>.dump      pg_dump -Fc: базу восстанавливают через pg_restore;
#   uploads-<UTC>.tgz  всё содержимое /data/uploads (путь файла записан в project_sources, сам файл — только здесь).
# Работает в контейнере backup (образ postgres: pg_dump той же версии, что и сервер). Подробности и восстановление — docs/backup.md.
#
# Настройка (переменные окружения контейнера):
#   BACKUP_INTERVAL_HOURS  как часто делать копию (по умолчанию 24; первая — сразу при запуске контейнера);
#   BACKUP_KEEP_DAYS       сколько дней хранить копии (по умолчанию 14);
#   BACKUP_ONCE=1          сделать одну копию и выйти (проверка вручную и тесты).
set -u

BACKUP_DIR=${BACKUP_DIR:-/backups}
UPLOAD_DIR=${UPLOAD_DIR:-/data/uploads}
KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}
INTERVAL_HOURS=${BACKUP_INTERVAL_HOURS:-24}
PG_DUMP=${PG_DUMP:-pg_dump}

log() { echo "[backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# Файл сначала пишется под временным именем и переименовывается только после успеха:
# оборванная копия не должна выглядеть настоящей.
run_once() {
  stamp=$(date -u +%Y%m%d-%H%M%S)
  mkdir -p "$BACKUP_DIR" || { log "ОШИБКА: нет доступа к $BACKUP_DIR"; return 1; }
  failed=0

  db_tmp="$BACKUP_DIR/db-$stamp.dump.tmp"
  # $PG_DUMP без кавычек намеренно: это команда (в тестах — «sh заглушка.sh»), а не только путь.
  if $PG_DUMP --format=custom --no-owner --file="$db_tmp" && [ -s "$db_tmp" ]; then
    mv "$db_tmp" "$BACKUP_DIR/db-$stamp.dump" && log "база: db-$stamp.dump"
  else
    rm -f "$db_tmp"
    log "ОШИБКА: дамп базы не создан"
    failed=1
  fi

  up_tmp="$BACKUP_DIR/uploads-$stamp.tgz.tmp"
  tar -czf "$up_tmp" -C "$UPLOAD_DIR" .
  rc=$?
  # tar завершается с кодом 1, если файл изменился во время чтения (кто-то загружал в этот момент): архив при этом годен.
  if [ "$rc" -le 1 ] && [ -s "$up_tmp" ]; then
    mv "$up_tmp" "$BACKUP_DIR/uploads-$stamp.tgz" && log "файлы: uploads-$stamp.tgz"
  else
    rm -f "$up_tmp"
    log "ОШИБКА: архив файлов не создан (код tar: $rc)"
    failed=1
  fi

  if [ "$failed" -ne 0 ]; then
    return 1
  fi

  date -u +%Y-%m-%dT%H:%M:%SZ > "$BACKUP_DIR/last-success"
  # Старые копии удаляются только после удачной: при серии сбоев последние рабочие копии не пропадут.
  find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'db-*.dump' -o -name 'uploads-*.tgz' \) -mtime +"$KEEP_DAYS" -delete
  find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.tmp' -mtime +1 -delete
  return 0
}

if [ "${BACKUP_ONCE:-0}" = "1" ]; then
  run_once
  exit $?
fi

log "запуск: копия каждые $INTERVAL_HOURS ч, хранение $KEEP_DAYS дн."
while true; do
  run_once || log "копия не сделана; следующая попытка через $INTERVAL_HOURS ч"
  sleep $((INTERVAL_HOURS * 3600))
done
