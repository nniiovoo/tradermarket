-- Read models for the Live Room Coordinator (spec: "Read models").
-- Every chain-derived table carries the block it was derived from. The whole
-- schema is a projection: it can be dropped and rebuilt from chain logs plus
-- the Session Event Log, and it is never an authority.
--
-- The service ships a file/in-memory projection store implementing the same
-- query surface; this DDL is the PostgreSQL form of the identical model.

create table if not exists room (
  room_id            text primary key,
  live_room_address  bytea not null unique,
  state              text not null,                    -- draft|armed|live|closing|settling|final|invalid
  headline_template  text not null,
  participant_a      jsonb not null,
  participant_b      jsonb not null,
  resolver_set       bytea[] not null,
  gate_signer        bytea not null,
  publisher          bytea not null,
  epoch_duration_s   int  not null,
  finality_delay_s   int  not null,
  announce_delay_s   int  not null,
  max_open_slots     int  not null,
  scheduled_start_at timestamptz,
  terminal_condition jsonb not null,
  stream             jsonb not null,
  room_seq           bigint not null default 0,
  last_observed_seq  numeric not null default 0,
  closed_source_seq  numeric,
  block_number       bigint not null,
  created_at         timestamptz not null default now()
);

create table if not exists program_slot (
  room_id           text not null references room(room_id),
  slot_index        int  not null,
  state             text not null,                     -- planned|announced|awaiting-liquidity|open|suspended|closed|recovering|provisional|challenged|final|invalid
  shape             text not null,                     -- participant|threshold|race
  question          text not null,
  template_id       text not null,
  params            jsonb not null,
  opening_condition jsonb not null,
  closing_condition jsonb not null,
  condition_hash    bytea not null,
  winner_reward_bps int  not null,
  market_address    bytea unique,
  published_seq     numeric,
  opens_at          timestamptz,
  closed_seq        numeric,
  block_number      bigint not null,
  primary key (room_id, slot_index)
);

create table if not exists market_state (
  market_address     bytea primary key,
  room_id            text not null,
  slot_index         int  not null,
  gate_state         smallint not null,
  reserve_a          numeric not null,
  reserve_b          numeric not null,
  implied_prob_a     numeric not null,                 -- cleared price only, never pending-adjusted
  total_lp_shares    numeric not null,
  winner_reward_pool numeric not null,
  pending_collateral numeric not null,
  collateral_backing numeric not null,
  unclaimed_lp_fees  numeric not null,
  current_epoch      bigint not null,
  last_safe_seq      numeric not null,
  final_outcome      smallint not null,
  provisional_at     timestamptz,
  challenge_ends_at  timestamptz,
  block_number       bigint not null,
  updated_at         timestamptz not null
);

create table if not exists market_action (
  market_address  bytea not null,
  action_id       bigint not null,
  epoch           bigint not null,
  kind            smallint not null,
  status          smallint not null,                   -- pending|executed|refunded
  account         bytea not null,
  outcome_a       boolean not null,
  amount          numeric not null,
  minimum_return  numeric not null,
  return_amount   numeric,
  submitted_block bigint not null,
  settled_block   bigint,
  primary key (market_address, action_id)
);

create table if not exists position_holding (
  market_address bytea not null,
  account        bytea not null,
  position_a     numeric not null default 0,
  position_b     numeric not null default 0,
  lp_shares      numeric not null default 0,
  block_number   bigint not null,
  primary key (market_address, account)
);

create table if not exists source_event (
  room_id     text   not null,
  seq         numeric not null,
  source      text   not null,
  participant text,
  kind        text   not null,
  observed_at timestamptz not null,
  ingested_at timestamptz not null,
  facts       jsonb  not null,
  derived     jsonb  not null,
  raw_ref     text   not null,
  raw_hash    bytea  not null,
  raw_query   jsonb  not null,
  prev_hash   bytea  not null,
  hash        bytea  not null,
  connector_signature bytea not null,
  primary key (room_id, seq)
);

create table if not exists publication_permit (
  room_id           text not null,
  nonce             numeric not null,
  slot_index        int  not null,
  condition_hash    bytea not null,
  params_hash       bytea not null,
  undecided_through numeric not null,
  expires_at        timestamptz not null,
  signature         bytea,
  outcome           text not null,                     -- signed|refused|consumed|expired
  refusal_reason    text,
  primary key (room_id, nonce)
);

create table if not exists room_event (
  room_id    text   not null,
  room_seq   bigint not null,
  type       text   not null,
  at         timestamptz not null,
  source_seq numeric,
  chain_ref  jsonb,
  payload    jsonb  not null,
  primary key (room_id, room_seq)
);

create index if not exists market_action_by_account on market_action (account);
create index if not exists program_slot_by_state on program_slot (room_id, state);
create index if not exists room_event_by_type on room_event (room_id, type);
