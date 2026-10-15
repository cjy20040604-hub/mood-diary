-- 晴一日记 · Supabase 数据库结构（可重复执行）
-- 1) 云同步：每个用户一行加密数据，行级安全保证只能读写自己的
create table if not exists public.vaults (
  user_id uuid primary key references auth.users(id) on delete cascade,
  blob text not null,
  updated_at timestamptz not null default now()
);
alter table public.vaults enable row level security;
drop policy if exists "own vault select" on public.vaults;
drop policy if exists "own vault insert" on public.vaults;
drop policy if exists "own vault update" on public.vaults;
drop policy if exists "own vault delete" on public.vaults;
create policy "own vault select" on public.vaults for select to authenticated using ((select auth.uid()) = user_id);
create policy "own vault insert" on public.vaults for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own vault update" on public.vaults for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own vault delete" on public.vaults for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on public.vaults from anon;

-- 2) 服务器推送：订阅表与配置表。不建任何策略并收回权限，只有服务端（边缘函数）能访问
create table if not exists public.push_subs (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  remind_min int not null default 1260,   -- 提醒时间，当地时间从 0 点起的分钟数
  mode text not null default 'fixed',     -- fixed 固定时间 / random 时间窗内随机
  win_end int,                            -- random 模式的时间窗结束分钟
  tz int not null default -480,           -- 浏览器 getTimezoneOffset()
  rnd_date text, rnd_min int,             -- 当天随机出的提醒分钟
  last_sent text,                         -- 最近一次提醒的当地日期
  created_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;
revoke all on public.push_subs from anon, authenticated;

create table if not exists public.push_config (k text primary key, v text not null);
alter table public.push_config enable row level security;
revoke all on public.push_config from anon, authenticated;
-- 需要在 push_config 写入：vapid_public / vapid_private / subject / cron_secret（不要提交到仓库）

-- 3) 每分钟触发一次边缘函数（把 <PROJECT_REF> 与 <CRON_SECRET> 换成你自己的值）
-- create extension if not exists pg_cron;
-- create extension if not exists pg_net with schema extensions;
-- select cron.schedule('qingyi-push', '* * * * *', $$
--   select net.http_post(
--     url := 'https://<PROJECT_REF>.supabase.co/functions/v1/push',
--     headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <ANON_KEY>','x-cron-secret','<CRON_SECRET>'),
--     body := '{"action":"cron"}'::jsonb) $$);

-- 4) 推送接口的频率限制：只存 IP / 推送地址的不可还原摘要和计数，定时任务每天清理
create table if not exists public.push_rl (
  k text primary key,
  n int not null,
  reset_at timestamptz not null
);
alter table public.push_rl enable row level security;
revoke all on public.push_rl from anon, authenticated;

-- 原子地计数：窗口内第几次调用；返回 true 表示仍在限额内
create or replace function public.push_hit(p_key text, p_max int, p_window int)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  insert into public.push_rl as r (k, n, reset_at)
  values (p_key, 1, now() + make_interval(secs => p_window))
  on conflict (k) do update set
    n = case when r.reset_at < now() then 1 else r.n + 1 end,
    reset_at = case when r.reset_at < now() then now() + make_interval(secs => p_window) else r.reset_at end
  returning n into v_n;
  return v_n <= p_max;
end $$;
revoke all on function public.push_hit(text, int, int) from public, anon, authenticated;
grant execute on function public.push_hit(text, int, int) to service_role;
