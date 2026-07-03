#!/bin/sh
# Runs once on first boot of the postgres container (docker-entrypoint-initdb.d).
# Creates the two application databases:
#   product — control-plane product data + Better Auth
#   world   — eve durability (@workflow/world-postgres)
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_USER" <<-EOSQL
	CREATE DATABASE product;
	CREATE DATABASE world;
EOSQL
