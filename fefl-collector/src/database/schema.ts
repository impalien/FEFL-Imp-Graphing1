/**
 * PostgreSQL schema. Design rule: NEVER OVERWRITE. Everything that changes over time is appended with a timestamp:
 *   raw_snapshots     the untouched JSON from each endpoint (gzipped, de-duplicated by hash)
 *   player_snapshots  one row each time a player's numbers change      (history of points, ownership, injuries, stats)
 *   club_snapshots    one row each time a club's numbers change        (history of points, form, league position, FDR)
 *   fixture_snapshots one row each time a fixture's status or score changes
 *   match_events      goals, assists, cards, penalties (insert-only)
 * players / clubs / gameweeks / fixtures are small "current view" lookup tables (names, positions, kickoff times); every value that
 * can change is also kept in the snapshot tables above, so history is never lost.
 * player_match_deltas is DERIVED (what each player did in one match, from before/after snapshots) and is insert-only too.
 */
export const SCHEMA = `
create table if not exists collection_runs (id bigserial primary key, started_at timestamptz not null default now(), finished_at timestamptz, trigger text, status text not null default 'running', note text);
create table if not exists raw_snapshots (id bigserial primary key, run_id bigint references collection_runs(id), endpoint text not null, fetched_at timestamptz not null default now(), sha1 text not null, bytes int, gz bytea not null);
create index if not exists raw_snapshots_ep on raw_snapshots (endpoint, fetched_at desc);
create table if not exists clubs (id int primary key, competition_id int, name text, short_name text, abbreviation text, bg text, tx text, updated_at timestamptz not null default now());
create table if not exists players (id int primary key, club_id int, competition_id int, first_name text, last_name text, display_name text, position text, updated_at timestamptz not null default now());
create table if not exists gameweeks (id int primary key, round_number int, name text, status text, lockout_at timestamptz, completed_at timestamptz, avg_points numeric, updated_at timestamptz not null default now());
create table if not exists fixtures (id bigint primary key, gameweek_id int, competition_id int, kickoff timestamptz, home_id int, away_id int, status text, finalized boolean, home_score int, away_score int, updated_at timestamptz not null default now());
create table if not exists fixture_snapshots (id bigserial primary key, run_id bigint, fixture_id bigint not null, collected_at timestamptz not null default now(), state_hash text not null, status text, finalized boolean, home_score int, away_score int);
create index if not exists fixture_snapshots_lookup on fixture_snapshots (fixture_id, collected_at desc);
create table if not exists player_snapshots (id bigserial primary key, run_id bigint, player_id int not null, collected_at timestamptz not null default now(), state_hash text not null, status text, total_points int, average_points numeric, round_points int, percent_selected numeric, appearances int, goals int, assists int, key_passes int, shots_on_target int, clean_sheets int, clearances int, blocks int, tackles int, interceptions int, saves int, last_three jsonb, suspension jsonb, injury jsonb);
create index if not exists player_snapshots_lookup on player_snapshots (player_id, collected_at desc);
create table if not exists club_snapshots (id bigserial primary key, run_id bigint, club_id int not null, collected_at timestamptz not null default now(), state_hash text not null, total_points int, average_points numeric, round_points int, percent_selected numeric, league_position int, fdr_home int, fdr_away int, last3_form text, last_three jsonb);
create index if not exists club_snapshots_lookup on club_snapshots (club_id, collected_at desc);
create table if not exists match_events (fixture_id bigint not null, player_id bigint not null, type text not null, minute int not null, period text not null, side text, assist_player_id bigint, first_seen timestamptz not null default now(), primary key (fixture_id, player_id, type, minute, period));
create table if not exists round_processing (round_id int primary key, status text not null, note text, processed_at timestamptz not null default now());
create table if not exists player_match_deltas (fixture_id bigint not null, player_id int not null, club_id int, opp_id int, position text, appearances int, goals int, assists int, key_passes int, shots_on_target int, clean_sheets int, clearances int, blocks int, tackles int, interceptions int, saves int, computed_at timestamptz not null default now(), primary key (fixture_id, player_id));
`;
