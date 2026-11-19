#!/bin/sh
# Выгрузка резервных копий (папка /backups, их делает backup.sh) в Backblaze B2 через S3-совместимый API.
# Файлы шифруются на сервере (rclone crypt) до отправки: в Backblaze лежит только шифртекст, ключ шифрования туда не попадает.
# Работает в контейнере backup-sync (образ rclone/rclone). Подробности, расшифровка и восстановление — docs/backup.md.
#
# Режимы:
#   (без аргументов)             цикл: выгрузка сразу после небольшой паузы и дальше раз в BACKUP_SYNC_INTERVAL_HOURS;
#   BACKUP_ONCE=1                одна выгрузка и выход (проверка вручную и тесты);
#   list                         показать, что лежит в бакете (имена и размеры расшифрованных файлов);
#   fetch <файл> <папка>         скачать файл из бакета и расшифровать (например: db-20261119-120000.dump /restore).
#
# Настройка (переменные окружения; значения берутся из .env сервера, в логи не попадают):
#   BACKUP_S3_ENDPOINT, BACKUP_S3_REGION, BACKUP_S3_BUCKET, BACKUP_S3_KEY_ID, BACKUP_S3_APPLICATION_KEY — бакет и ключ B2;
#   BACKUP_ENCRYPTION_PASSWORD — пароль шифрования, BACKUP_ENCRYPTION_SALT — соль (необязательна, но лучше задать).
#   ПОТЕРЯ ПАРОЛЯ = КОПИИ В B2 НЕВОЗМОЖНО РАСШИФРОВАТЬ. Храните его вне сервера и вне GitHub (оттуда его не прочитать).
#   Без этих значений выгрузка отключена: копии остаются только на сервере.
# -f: шаблоны db-*.dump в $FILTER должен раскрывать rclone, а не шелл по файлам текущей папки.
set -uf

LOCAL_DIR=${BACKUP_DIR:-/backups}
INTERVAL_HOURS=${BACKUP_SYNC_INTERVAL_HOURS:-6}
INITIAL_DELAY=${BACKUP_SYNC_INITIAL_DELAY_SEC:-120}
RCLONE=${RCLONE:-rclone}

log() { echo "[backup-sync] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# Имена обязательных переменных, которые не заданы. Сами значения нигде не печатаются.
missing_vars() {
  for name in BACKUP_S3_ENDPOINT BACKUP_S3_REGION BACKUP_S3_BUCKET BACKUP_S3_KEY_ID BACKUP_S3_APPLICATION_KEY BACKUP_ENCRYPTION_PASSWORD; do
    eval "value=\${$name:-}"
    [ -n "$value" ] || printf '%s ' "$name"
  done
}

# Удалённые хранилища описываются переменными окружения rclone, конфиг-файл не создаётся (секреты не ложатся на диск):
#   b2s3   — бакет B2 по S3 API;
#   bcrypt — слой шифрования поверх b2s3:<бакет>/backups. Имена файлов не шифруются: в них только время копии.
setup_remotes() {
  export RCLONE_CONFIG_B2S3_TYPE=s3
  export RCLONE_CONFIG_B2S3_PROVIDER=Other
  export RCLONE_CONFIG_B2S3_ENDPOINT="$BACKUP_S3_ENDPOINT"
  export RCLONE_CONFIG_B2S3_REGION="$BACKUP_S3_REGION"
  export RCLONE_CONFIG_B2S3_ACCESS_KEY_ID="$BACKUP_S3_KEY_ID"
  export RCLONE_CONFIG_B2S3_SECRET_ACCESS_KEY="$BACKUP_S3_APPLICATION_KEY"
  # Ключ привязан к одному бакету и не умеет его создавать: проверку и создание бакета rclone не делает.
  export RCLONE_CONFIG_B2S3_NO_CHECK_BUCKET=true

  export RCLONE_CONFIG_BCRYPT_TYPE=crypt
  export RCLONE_CONFIG_BCRYPT_REMOTE="b2s3:$BACKUP_S3_BUCKET/backups"
  export RCLONE_CONFIG_BCRYPT_FILENAME_ENCRYPTION=off
  export RCLONE_CONFIG_BCRYPT_DIRECTORY_NAME_ENCRYPTION=false
  # rclone принимает пароли crypt только в «обфусцированном» виде; пароль подаём через stdin, не аргументом.
  RCLONE_CONFIG_BCRYPT_PASSWORD=$(printf '%s' "$BACKUP_ENCRYPTION_PASSWORD" | $RCLONE obscure -) || return 1
  export RCLONE_CONFIG_BCRYPT_PASSWORD
  if [ -n "${BACKUP_ENCRYPTION_SALT:-}" ]; then
    RCLONE_CONFIG_BCRYPT_PASSWORD2=$(printf '%s' "$BACKUP_ENCRYPTION_SALT" | $RCLONE obscure -) || return 1
    export RCLONE_CONFIG_BCRYPT_PASSWORD2
  fi
}

# Только готовые копии: временные файлы (.tmp) и служебные (last-success) в бакет не уходят.
FILTER="--include db-*.dump --include uploads-*.tgz"

sync_once() {
  # Копируем, а не синхронизируем: удаление старых копий на сервере не должно стирать их в бакете.
  # Срок хранения в бакете задаёт правило жизненного цикла Backblaze.
  # shellcheck disable=SC2086
  if ! $RCLONE copy "$LOCAL_DIR" bcrypt: $FILTER --stats 0 --log-level NOTICE; then
    log "ОШИБКА: выгрузка не удалась"
    return 1
  fi
  # Сверка: каждая локальная копия есть в бакете и совпадает по размеру (хеши через слой шифрования не сравниваются).
  # shellcheck disable=SC2086
  if ! $RCLONE check "$LOCAL_DIR" bcrypt: --one-way --size-only $FILTER --log-level NOTICE; then
    log "ОШИБКА: после выгрузки копии в бакете не совпали с локальными"
    return 1
  fi
  log "готово: копии из $LOCAL_DIR есть в бакете $BACKUP_S3_BUCKET (зашифрованы)"
  return 0
}

mode=${1:-sync}
case "$mode" in
  list | fetch | sync) ;;
  *) echo "Использование: backup-sync.sh [list | fetch <файл> <папка>]" >&2; exit 2 ;;
esac

missing=$(missing_vars)
if [ -n "$missing" ]; then
  log "выгрузка в B2 не настроена, не заданы: $missing"
  [ "$mode" = "sync" ] || exit 1
  [ "${BACKUP_ONCE:-0}" = "1" ] && exit 0
  # Контейнер остаётся запущенным: иначе выкладка (compose --wait) сочла бы его упавшим. Значения подхватятся при следующей выкладке.
  while true; do sleep 86400; done
fi

setup_remotes || { log "ОШИБКА: не удалось подготовить шифрование"; exit 1; }

case "$mode" in
  list)
    $RCLONE lsl bcrypt: --log-level NOTICE
    exit $?
    ;;
  fetch)
    file=${2:-}
    dest=${3:-}
    [ -n "$file" ] && [ -n "$dest" ] || { echo "Использование: backup-sync.sh fetch <файл> <папка>" >&2; exit 2; }
    mkdir -p "$dest" || exit 1
    $RCLONE copy "bcrypt:$file" "$dest" --log-level NOTICE
    exit $?
    ;;
esac

if [ "${BACKUP_ONCE:-0}" = "1" ]; then
  sync_once
  exit $?
fi

log "запуск: выгрузка в B2 каждые $INTERVAL_HOURS ч (первая через $INITIAL_DELAY с)"
sleep "$INITIAL_DELAY"
while true; do
  sync_once || log "выгрузка не выполнена; следующая попытка через $INTERVAL_HOURS ч"
  sleep $((INTERVAL_HOURS * 3600))
done
