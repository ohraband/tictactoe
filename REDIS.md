# Redis: running several game servers

By default rooms live in one server's memory. With Redis they live in Redis, so any number of servers can share them: two players can be connected to different servers and still play each other.

## Try it

    docker compose --profile redis up -d --build

This starts Redis and two game servers that share it. No `.env` changes are needed.

1. Check what is running: `docker compose --profile redis ps`. You should see `game-a` on 8081 and `game-b` on 8082 (and `game` on 8080, which keeps its own rooms in memory).
2. Open http://localhost:8081 and http://localhost:8082. These are two different servers.
3. Create a room on one and join it from the other. Moves, reactions, rematches, and the "opponent connected" status work across them.
4. Stop one (`docker compose stop game-a`) during a game. Refreshing the page on the other server resumes it.

If a server logs `"rooms":"memory"`, it is not using Redis. `game-a` and `game-b` should log `"rooms":"redis"`.

## How it works

| What | Where |
|---|---|
| Room state (board, seats, scores) | `room:CODE` in Redis, as JSON, with a 10 minute expiry that is refreshed while someone is connected |
| Atomic updates | a short per-room lock, so two servers cannot overwrite each other's moves |
| Live updates | one pub/sub channel. Every server receives every update and forwards it to its own connected players |
| "Is this player connected" | a marker per seat, refreshed by the 20 second heartbeat |
| Rate limits | counters in Redis, so the limits hold across all servers |

The browser ignores updates older than the one it already shows, using a version number on each room.

## Limits to know about

- The forfeit timer runs on the server that saw the player disconnect. If that server crashes, the timer is lost and the game does not forfeit. The room expires after 10 minutes of silence.
- Every server receives updates for every room. That is fine for this project, but a larger system would use one channel per room.
- A load balancer in front of several servers must not buffer the live streams (for nginx: `proxy_buffering off`).
- Redis holds no backup. If it restarts, active rooms are lost, and players see "game no longer exists".
