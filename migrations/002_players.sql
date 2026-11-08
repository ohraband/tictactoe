create table if not exists players (
  id bigserial primary key,
  name text not null,
  name_key text not null unique,
  secret_hash text not null unique,
  created_at timestamptz not null default now()
);
alter table games
  add column if not exists x_player_id bigint references players(id),
  add column if not exists o_player_id bigint references players(id);
create index if not exists games_x_player on games (x_player_id);
create index if not exists games_o_player on games (o_player_id);
