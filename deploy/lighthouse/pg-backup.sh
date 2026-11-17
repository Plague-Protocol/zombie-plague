#!/bin/sh
# Nightly dump of the outbreak database, kept 14 days. Cron (as ubuntu):
#   30 3 * * * /opt/outbreak/deploy/lighthouse/pg-backup.sh >> /opt/outbreak-backups/backup.log 2>&1
# Restore: gunzip -c FILE | docker exec -i outbreak-postgres-1 psql -U outbreak -d outbreak
set -eu
DIR=/opt/outbreak-backups
mkdir -p "$DIR"
STAMP=$(date -u +%Y%m%d-%H%M%S)
docker exec outbreak-postgres-1 pg_dump -U outbreak -d outbreak | gzip > "$DIR/outbreak-$STAMP.sql.gz"
find "$DIR" -name 'outbreak-*.sql.gz' -mtime +14 -delete
echo "$(date -u) backup ok: outbreak-$STAMP.sql.gz"
