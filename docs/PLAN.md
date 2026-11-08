# Tic Tac Toe Website: Project Plan

Reference document. Status: reviewed, ready to build. Last updated: 2026-10-24.

## 1. Goals and scope

A tic tac toe website with single-player and multiplayer modes, playable on desktop and mobile, with no accounts or database in the MVP.

### Game modes

- **Single player:** play against an AI with Easy, Medium, and Hard difficulty.
- **Local two-player:** two people share one device (hot-seat), no networking.
- **Online multiplayer:** play a friend through a shareable room link or code. Random matchmaking is a later feature.

### Non-goals for the MVP

Accounts, persistence, leaderboards, chat, matchmaking, spectators, and multi-instance scaling.

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript throughout | Shared types between client and server prevent event-shape bugs |
| Frontend | React + Vite | Fast, simple state-driven UI |
| Realtime | Socket.IO | Rooms, reconnection, and fallback transport out of the box |
| Backend | Node.js + Express | Same language as the frontend, so game logic is shared |
| Monorepo | npm workspaces (`shared`, `client`, `server`) | Lets client and server import the same logic package |
| Hosting | Fly.io, Railway, or Render | Support WebSocket servers cheaply (see hosting notes below) |
| Database | None for the MVP | Rooms live in server memory |

## 3. Architecture

A **shared, pure game-logic package** is used by the client, the AI, and the server:

- `createBoard()`
- `applyMove(state, index)`
- `getWinner(state)` (returns the winner and the winning line)
- `isDraw(state)`
- `getLegalMoves(state)`

For online play the **server is authoritative**: clients send move requests, the server validates them (correct player, correct turn, empty cell, game not over), updates state, and broadcasts it. Clients never decide outcomes.

The client may apply moves optimistically for responsiveness, but always reconciles with the server's `state_update`.

## 4. AI design

- **Easy:** random legal move.
- **Medium:** win if possible, otherwise block the opponent's win, otherwise play randomly. (Optional: prefer center, then corners, for a more natural feel.)
- **Hard:** minimax. Unbeatable on 3x3 and instant, so no optimization is needed.
- Add a 300 to 600 ms delay before the AI moves so it feels natural.
- Player chooses to play as X or O. X always moves first.

## 5. Online multiplayer

### Flow

1. Player A clicks **Create Game**. The server generates a room code (for example `K7QD`) and a link.
2. Player A shares the link. Player B opens it and joins.
3. The server assigns X and O and starts the game.
4. Clients send `make_move`; the server validates and broadcasts `state_update`.
5. At game end, **both** players must accept a rematch. The player who was X swaps with the player who was O.

### Identity and reconnection

- On joining, the server issues a **player token** (random ID). The client stores it in `sessionStorage` or `localStorage`.
- On reconnect (page refresh, dropped connection), the client presents the token to reclaim its seat. A socket ID alone is not enough because it changes on every reconnect.
- Hold a disconnected player's seat for 30 to 60 seconds, then end the game or award a forfeit.

### Room codes

- 4 to 6 characters from an unambiguous alphabet (no `0/O`, `1/I/L`).
- Check for collisions against active rooms when generating.
- Rate-limit join attempts so codes cannot be brute-forced.

### Server hardening

- Validate every event payload (move index is an integer from 0 to 8, room code format, and so on).
- Rate-limit events per socket.
- Configure CORS and allowed origins explicitly.
- Sanitize display names if names are added.

### Edge cases

- Third person opens a full room: show "Room full".
- Abandoned or finished rooms: delete after a timeout (for example 10 minutes idle).
- Out-of-turn, duplicate, or rapid clicks: reject on the server.
- Opponent leaves mid-game: notify the other player and offer to return to the menu.
- Server restart: in-memory rooms are lost. Show a clear "game no longer exists" message.

### Events

`create_room`, `join_room`, `make_move`, `state_update`, `request_rematch`, `rematch_accepted`, `player_left`, `player_reconnected`, `error`. Define all payload types once in `shared`.

## 6. Screens and UI

1. **Home:** Play vs Computer, Play Locally, Play Online.
2. **Setup:** pick difficulty and side (single player), or create or enter a room code (online).
3. **Game board:** 3x3 grid, turn indicator, player marks, score tally, restart and leave buttons.
4. **Result overlay:** win, loss, or draw, with Rematch and Back to Menu.
5. **Waiting room:** room code, copy-link button, "Waiting for opponent...".

### UX and accessibility

- Highlight the winning line.
- Keyboard navigation and ARIA labels on cells (for example "Row 1, column 2, empty").
- Announce turn changes and results to screen readers (`aria-live`).
- Mobile-first layout with large tap targets.
- Light and dark themes; do not rely on color alone to tell X from O.
- Subtle placement animations, respecting `prefers-reduced-motion`.
- Optional sound toggle, off by default.
- Deep link: opening `/room/K7QD` joins directly.

## 7. Project structure

```
tictactoe/
├── package.json        # npm workspaces
├── docs/
│   └── PLAN.md         # this file
├── shared/             # game logic (pure functions), event and state types
├── client/             # React app: screens, components, AI, hooks
└── server/             # Express + Socket.IO, room manager
```

## 8. Build phases

1. **Core logic:** shared module with unit tests covering all 8 win lines, draws, and illegal moves.
2. **Local play:** board UI and hot-seat mode.
3. **Single player:** AI with three difficulties and a menu.
4. **Online MVP:** server, rooms, move validation, waiting room.
5. **Robustness:** player tokens, reconnects, rematch handshake, room cleanup, rate limiting.
6. **Polish:** animations, responsive design, accessibility, sound.
7. **Deploy:** CI, hosting, HTTPS (required for secure WebSockets), custom domain.

## 9. Testing

- **Unit:** game logic and each AI level. Hard must never lose across thousands of simulated games (for example Hard vs random as both X and O).
- **Integration:** two simulated socket clients playing a full game, plus disconnect, reconnect, full-room, and out-of-turn scenarios.
- **Manual:** mobile browsers, slow networks, and screen reader spot checks.

## 10. Deployment notes

- **Single server instance for the MVP.** Rooms are in memory, so running multiple instances would split players across servers. Scaling later requires the Socket.IO Redis adapter plus sticky sessions or a shared room store.
- **Free tiers may sleep** after inactivity (Render does this), causing a slow first connection. Use a paid tier, a keep-alive, or a host that does not sleep.
- Serve the client and server from the same origin if possible to avoid CORS complexity.
- Add a `/health` endpoint for the host's health checks.

## 11. Stretch features

- Random matchmaking queue
- Accounts, win/loss stats, leaderboards
- Chat or emoji reactions
- Spectator mode (changes the "room full" behavior)
- Variants: 4x4, 5-in-a-row, Ultimate Tic Tac Toe
- Custom marks and board themes
- Installable PWA with offline single-player and local modes

## 12. Review notes (changes from the first draft)

- Added **TypeScript and npm workspaces**, since sharing code between client and server needs a defined setup.
- Added **player tokens** for reconnection; reserving a seat by socket ID would not survive a reconnect.
- Clarified **who moves first**: X always starts, and rematches swap sides.
- Made the **rematch a two-sided handshake** instead of either player being able to trigger it.
- Added **server hardening**: payload validation, rate limiting, CORS, and room-code entropy and collision checks.
- Added **deployment caveats**: single instance, in-memory rooms lost on restart, free-tier sleep, and scaling requirements.
- Added accessibility details: `aria-live` announcements, reduced motion, and non-color-only mark distinction.
- Noted that spectator mode conflicts with the "room full" rule and must be designed together if added.

## 13. Suggested MVP

Local play, AI play, and online rooms via share link. No database, no accounts. Estimated effort: a weekend to one week.

## 14. Open decisions

- Final hosting provider
- Whether the room creator picks their side or it is random
- Whether to include display names in the MVP
- Visual style and branding
