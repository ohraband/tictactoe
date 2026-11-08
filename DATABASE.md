# Database (Postgres)

`docker compose up -d --build` also starts a `gamedb` Postgres container. The game saves each finished online game (room code, both nicknames, winner, move count, time) and shows a leaderboard from the home screen.

- Nicknames: players type one in the online lobby. It is saved in the browser and shown during the game.
- Without `DATABASE_URL` the game still runs, just without saving or a leaderboard.
- The schema is managed by versioned files in `migrations/`, applied once each at startup (tracked in a `schema_migrations` table).
- Change the database password with `GAME_DB_PASSWORD=yourpassword docker compose up -d --build` (set it the first time; changing it later needs `docker compose down -v`, which erases data).

Look at the data:

    docker compose exec gamedb psql -U game tictactoe -c "select * from games order by id desc limit 10;"

Check it is connected: http://localhost:8080/api/health should show `"database":true`.

## Guest profiles and match history

With the database on, online play needs a guest nickname:

- In the online lobby, choose a nickname and press Save nickname. Nicknames are unique (not case-sensitive), 2 to 16 letters or numbers.
- The server gives the browser a private key, stored in that browser's local storage. It proves the nickname is yours, and only a hash of it is stored in the database.
- This is a guest account, not a full login. Clearing browser data, or using another browser or device, means you cannot get that nickname back.
- "My match history" shows your last 25 online games. On the Leaderboard, click any name to see their games.

Tables: `players` (nicknames) and `games` (finished games, linked to both players). See them with:

    docker compose exec gamedb psql -U game tictactoe -c "select * from players;"
    docker compose exec gamedb psql -U game tictactoe -c "select * from games order by id desc limit 10;"

Games saved before this update have no linked players, so they don't appear on the leaderboard.
