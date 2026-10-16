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

-- 5) 改进计划（用户自愿加入）：每天最多一行匿名汇总，不含任何日记内容
create table if not exists public.metrics_daily (
  install_id uuid not null,                 -- 本机随机生成，退出后重新生成
  day date not null,                        -- 上报当天（用户本地日期）
  records_7d int not null check (records_7d between 0 and 1000),
  active_days_7d int not null check (active_days_7d between 0 and 7),
  practices_7d int not null check (practices_7d between 0 and 500),
  rated_7d int not null check (rated_7d between 0 and 500),
  avg_delta_7d numeric(4,2) check (avg_delta_7d between -4 and 4),
  first_day date check (first_day <= day),  -- 首次使用日期，用来计算留存
  v text check (length(v) <= 20),
  created_at timestamptz not null default now(),
  primary key (install_id, day)
);
alter table public.metrics_daily enable row level security;
revoke all on public.metrics_daily from anon, authenticated;
drop policy if exists "insert metrics" on public.metrics_daily;
-- 只能通过下面的函数写入：校验日期，同一天重复上报直接忽略；表本身不对前端开放读写
create or replace function public.report_day(p_install uuid, p_day date, p_records int, p_active int, p_practices int, p_rated int, p_delta numeric, p_first date, p_v text)
returns void language plpgsql security definer set search_path = public as $
begin
  if p_day not between current_date - 1 and current_date + 1 then raise exception 'invalid day'; end if;
  insert into public.metrics_daily (install_id, day, records_7d, active_days_7d, practices_7d, rated_7d, avg_delta_7d, first_day, v)
  values (p_install, p_day, p_records, p_active, p_practices, p_rated, p_delta, p_first, p_v)
  on conflict (install_id, day) do nothing;
end $;
revoke all on function public.report_day(uuid, date, int, int, int, int, numeric, date, text) from public;
grant execute on function public.report_day(uuid, date, int, int, int, int, numeric, date, text) to anon, authenticated;

-- 6) 反馈：只能写入，不能读出
create table if not exists public.feedback (
  id bigserial primary key,
  install_id uuid,
  body text not null check (length(body) between 2 and 1000),
  contact text check (length(contact) <= 100),
  v text check (length(v) <= 20),
  created_at timestamptz not null default now()
);
alter table public.feedback enable row level security;
revoke all on public.feedback from anon, authenticated;
grant insert on public.feedback to anon, authenticated;
grant usage on sequence public.feedback_id_seq to anon, authenticated;
drop policy if exists "insert feedback" on public.feedback;
create policy "insert feedback" on public.feedback for insert to anon, authenticated with check (true);

-- 退出改进计划：按安装 ID 删除已上报的数据（ID 只有本机知道）
create or replace function public.forget_install(p_id uuid) returns void
language sql security definer set search_path = public as $$
  delete from public.metrics_daily where install_id = p_id;
  delete from public.feedback where install_id = p_id;
$$;
revoke all on function public.forget_install(uuid) from public;
grant execute on function public.forget_install(uuid) to anon, authenticated;

-- 保存期限：最长 12 个月，每天自动清理
select cron.schedule('qingyi-retention', '0 3 * * *', $$
  delete from public.metrics_daily where created_at < now() - interval '365 days';
  delete from public.feedback where created_at < now() - interval '365 days' $$);
