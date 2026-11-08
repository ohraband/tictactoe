create table if not exists games (
  id bigserial primary key,
  room_code text not null,
  x_name text not null,
  o_name text not null,
  winner text,
  draw boolean not null default false,
  moves int not null,
  created_at timestamptz not null default now()
);
