# Logging with Grafana + Loki (local, Docker)

The logging stack is optional. It only starts with `--profile observability`; plain `docker compose up` runs just the game and database.

Grafana, Loki, and Alloy are widely used open-source tools. The game prints one JSON log line per event to stdout. Alloy reads the Docker container logs and sends them to Loki, and Grafana shows them. Nothing leaves your machine.

## Start

    docker compose --profile observability up -d --build

- Game: http://localhost:8080
- Grafana: http://localhost:3001 (login `admin` / `admin`, skip or change the password prompt)

The "Tic Tac Toe" dashboard opens as the home page. Play a game, wait about 10 seconds, and it fills in.

## What gets logged

One JSON line per event, for example:

    {"ts":"2026-10-24T14:00:00.000Z","severity":"info","event":"game_start","visitor":"...","mode":"ai","level":"hard","side":"X"}

Events: `game_start`, `game_end`, and the room and visitor events the game already records. Visitor IDs are anonymous random IDs.

## Search logs yourself

In Grafana, open Explore, pick Loki, and try:

    {service="game"} | json | event="game_end"
    {service="game"} | json | result="win"
    {service="game"} |= "error"

## Troubleshooting

    docker compose ps                 # all four services should be running
    docker compose logs -f game       # the JSON lines should appear here
    docker compose logs alloy         # errors reading the Docker socket
    docker compose logs loki

- No data at all: set the dashboard time range to "Last 15 minutes" and check `docker compose logs alloy`.
- Alloy cannot read the socket: on Linux, `/var/run/docker.sock` must be readable. On Docker Desktop (Windows/Mac) it works by default.

## Stop

    docker compose down        # keeps data
    docker compose down -v     # deletes all logs and dashboards state

## Reset the Grafana password

GRAFANA_PASSWORD only applies the first time Grafana starts. If you cannot log in, run:

    docker compose exec grafana grafana cli admin reset-admin-password YOUR_NEW_PASSWORD

Then log in as `admin` with that password.

## Metrics (Prometheus)

The game exposes Prometheus metrics on port 9100, inside the Docker network only (it is not published to your machine). Prometheus scrapes every game container, and Grafana has a second dashboard, "Tic Tac Toe - Metrics".

- Prometheus UI: http://localhost:9090 (try `tictactoe_rooms_active` or `sum by (route) (rate(tictactoe_http_requests_total[1m]))`)
- Check the raw output: `docker compose exec game wget -qO- http://127.0.0.1:9100/metrics`
- Without Docker, set `METRICS_PORT` (default 9100, `0` turns it off).

Logs and metrics complement each other. Logs (Loki) answer "what happened in this game", metrics (Prometheus) answer "how is the server doing right now": rooms, live connections, request rate and latency, rate limiting, memory, and CPU, per server.

Main metrics: `tictactoe_http_requests_total`, `tictactoe_http_request_duration_seconds`, `tictactoe_rooms_active`, `tictactoe_sse_connections`, `tictactoe_games_finished_total`, `tictactoe_reactions_total`, `tictactoe_rate_limited_total`, `tictactoe_db_save_errors_total`, plus `process_*` memory, CPU, and uptime.
