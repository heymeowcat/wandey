/**
 * Schema migrations.
 *
 * Wandey stores everything in one SQLite file next to the user's config, so
 * "install" is a single Bun binary and "backup" is copying one file.
 */
export const MIGRATIONS: string[] = [
  // 0 -> 1
  `
  create table if not exists session (
    id text primary key,
    title text not null,
    mode text not null default 'chat',
    model text,
    parent_id text,
    archived integer not null default 0,
    created_at integer not null,
    updated_at integer not null
  );

  create table if not exists message (
    id text primary key,
    session_id text not null references session(id) on delete cascade,
    role text not null,
    model text,
    error text,
    finish_reason text,
    usage text,
    created_at integer not null
  );
  create index if not exists message_session on message(session_id, created_at);

  create table if not exists part (
    id text primary key,
    session_id text not null references session(id) on delete cascade,
    message_id text not null references message(id) on delete cascade,
    type text not null,
    ord integer not null,
    data text not null,
    created_at integer not null
  );
  create index if not exists part_message on part(message_id, ord);

  create table if not exists source (
    id text not null,
    session_id text not null references session(id) on delete cascade,
    url text not null,
    canonical_url text not null,
    title text not null default '',
    site text not null default '',
    snippet text not null default '',
    text text not null default '',
    content text not null default '',
    status integer not null default 0,
    words integer not null default 0,
    via text not null default 'http',
    meta text,
    fetched_at integer not null,
    primary key (session_id, id),
    unique (session_id, canonical_url)
  );
  create index if not exists source_session on source(session_id, fetched_at);

  create table if not exists research_job (
    id text primary key,
    session_id text not null references session(id) on delete cascade,
    question text not null,
    depth text not null,
    status text not null,
    plan text,
    report text,
    error text,
    output_path text,
    created_at integer not null,
    updated_at integer not null
  );
  create index if not exists research_session on research_job(session_id, created_at);

  create table if not exists research_note (
    id text primary key,
    session_id text not null references session(id) on delete cascade,
    job_id text not null references research_job(id) on delete cascade,
    claim text not null,
    quote text not null default '',
    source_id text not null,
    source_title text not null default '',
    source_url text not null default '',
    sub_question_id text not null default '',
    confidence text not null default 'medium',
    round integer not null default 1,
    created_at integer not null
  );
  create index if not exists note_job on research_note(job_id, created_at);

  create table if not exists kv (
    key text primary key,
    value text not null
  );
  `,
];
