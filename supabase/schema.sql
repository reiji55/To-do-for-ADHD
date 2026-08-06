-- ============================================================
-- Horme Phase 0.5 — スキーマ / RLS
-- concept v0.7 §12 準拠。Supabase の SQL Editor に貼って実行してください。
-- 実行順は上から下へ1回。再実行しても壊れないよう IF NOT EXISTS / OR REPLACE を使っています。
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- goals（目標） ----------

create table if not exists public.goals (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,

  title            text not null,
  category         text,                                   -- 固定少数・属性表示のみ
  capacity         text not null default '中',               -- 軽／中／重（取り掛かるのに必要なエネルギー）
  important_flag   boolean not null default false,          -- ＝本命か
  status           text not null default '未着手',            -- 進行中／未着手／完了／寝かせ

  process_steps    jsonb not null default '[]'::jsonb,      -- [{ id, title, done }]（順序を保持）
  steps_done       jsonb not null default '[]'::jsonb,      -- [{ title, at, minutes }]

  bookmark         jsonb,                                   -- { note, short, started_step_id } / null
                                                              -- v0.7は「sessionsは独立でも goals に持たせてもよい」→ 1行で完結する goals 側を採用

  progress_felt    integer,                                 -- 体感%・null可
  passed_count     integer not null default 0,              -- 本命枠で見送られた回数
  last_passed_at   timestamptz,

  last_touched_at  timestamptz not null default now(),
  completed_at     timestamptz,                             -- 目標の完了日時（棚の「終わったもの」表示に使用）

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists goals_user_id_idx on public.goals (user_id);

alter table public.goals enable row level security;

drop policy if exists "goals_select_own" on public.goals;
create policy "goals_select_own" on public.goals
  for select using (user_id = auth.uid());

drop policy if exists "goals_insert_own" on public.goals;
create policy "goals_insert_own" on public.goals
  for insert with check (user_id = auth.uid());

drop policy if exists "goals_update_own" on public.goals;
create policy "goals_update_own" on public.goals
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "goals_delete_own" on public.goals;
create policy "goals_delete_own" on public.goals
  for delete using (user_id = auth.uid());

-- updated_at を書き込みのたびに自動更新
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists goals_set_updated_at on public.goals;
create trigger goals_set_updated_at
  before update on public.goals
  for each row execute function public.set_updated_at();

-- ---------- inbox_items（未仕分けの捕獲） ----------
-- 仕分けで「目標にする」「手放す」を選んだ時点で行ごと物理削除する運用。
-- status は将来の拡張のために残すが、現状は 'unsorted' のみが存在する想定。

create table if not exists public.inbox_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,

  text        text not null,
  source      text not null default 'pwa',
  status      text not null default 'unsorted',

  created_at  timestamptz not null default now()
);

create index if not exists inbox_items_user_id_idx on public.inbox_items (user_id);

alter table public.inbox_items enable row level security;

drop policy if exists "inbox_select_own" on public.inbox_items;
create policy "inbox_select_own" on public.inbox_items
  for select using (user_id = auth.uid());

drop policy if exists "inbox_insert_own" on public.inbox_items;
create policy "inbox_insert_own" on public.inbox_items
  for insert with check (user_id = auth.uid());

drop policy if exists "inbox_delete_own" on public.inbox_items;
create policy "inbox_delete_own" on public.inbox_items
  for delete using (user_id = auth.uid());

-- ============================================================
-- 実装メモ（v0.7 §12 との差分）
-- ・sessions テーブルは作らず、bookmark を goals の1カラム(jsonb)に持たせた。
--   （v0.7が明示的に許容している選択：「goalsに持たせるか独立テーブルにするかは実装側の判断でよい」）
-- ・completed_at を追加。棚の「終わったもの」で完了日を表示するために必要（v0.7 §5.8）。
-- ・progress_felt は挙動上、クライアント内部では felt_progress という名前で扱う。
--   DBカラム名は指示書の表記(progress_felt)に合わせ、アプリ側で相互変換している。
-- ============================================================
