create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 80),
  email text not null,
  role text not null default 'student' check (role in ('student', 'admin')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 100),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index departments_name_unique on public.departments (lower(name));

create table public.levels (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (id, department_id)
);
create unique index levels_department_name_unique on public.levels (department_id, lower(name));

create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  level_id uuid not null references public.levels(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  created_at timestamptz not null default now(),
  unique (id, level_id)
);
create unique index subjects_level_name_unique on public.subjects (level_id, lower(name));

create table public.resources (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('book', 'video')),
  title text not null check (char_length(title) between 1 and 140),
  author text not null default '' check (char_length(author) <= 100),
  description text not null default '' check (char_length(description) <= 1200),
  department_id uuid not null references public.departments(id) on delete cascade,
  level_id uuid not null,
  subject_id uuid not null,
  original_name text not null check (char_length(original_name) between 1 and 255),
  extension text not null check (extension = lower(extension)),
  size_bytes bigint not null check (size_bytes > 0 and
    ((kind = 'book' and size_bytes <= 52428800) or (kind = 'video' and size_bytes <= 314572800))),
  storage_bucket text not null check (storage_bucket in ('books', 'videos')),
  storage_path text not null unique,
  downloads bigint not null default 0 check (downloads >= 0),
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint resource_level_department_fk foreign key (level_id, department_id)
    references public.levels(id, department_id) on delete cascade,
  constraint resource_subject_level_fk foreign key (subject_id, level_id)
    references public.subjects(id, level_id) on delete cascade,
  constraint resource_kind_bucket_match check (
    (kind = 'book' and storage_bucket = 'books') or
    (kind = 'video' and storage_bucket = 'videos')
  ),
  constraint resource_extension_kind_match check (
    (kind = 'book' and extension in (
      '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.pptm', '.xls', '.xlsx',
      '.txt', '.rtf', '.csv', '.md', '.epub', '.odt', '.ods', '.odp', '.jpg', '.jpeg', '.png'
    )) or
    (kind = 'video' and extension in ('.mp4', '.webm', '.mov', '.m4v'))
  )
);
create index resources_department_idx on public.resources (department_id, created_at desc);
create index resources_level_idx on public.resources (level_id);
create index resources_subject_idx on public.resources (subject_id);
create index resources_kind_created_idx on public.resources (kind, created_at desc);
create index resources_search_idx on public.resources using gin (
  to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(author, '') || ' ' || coalesce(description, ''))
);

create table public.favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  resource_id uuid not null references public.resources(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, resource_id)
);
create index favorites_user_idx on public.favorites (user_id);

create table public.activity (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  resource_id uuid not null references public.resources(id) on delete cascade,
  action text not null check (action in ('opened', 'downloaded')),
  created_at timestamptz not null default now()
);
create index activity_user_created_idx on public.activity (user_id, created_at desc);
create index activity_action_idx on public.activity (action);

create table public.developers (
  id text primary key,
  name text not null check (char_length(name) between 1 and 80),
  role text not null default '',
  bio text not null default '',
  accent text not null default 'sage' check (accent in ('sage', 'sand', 'blue', 'rose', 'gold', 'lavender')),
  photo_path text,
  sort_order integer not null default 0
);

create or replace function public.is_library_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin' and active
  );
$$;

create or replace function public.create_library_profile()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
begin
  insert into public.profiles (id, name, email, role)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''), 'Nasawa Learner'),
    coalesce(new.email, ''),
    'student'
  );
  return new;
end;
$$;

create or replace function public.provision_first_library_admin(target_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtext('nasawa-first-library-admin'));
  if exists (select 1 from public.profiles where role = 'admin') then
    return false;
  end if;
  update public.profiles set role = 'admin' where id = target_user_id and role = 'student';
  return found;
end;
$$;
revoke all on function public.provision_first_library_admin(uuid) from public, anon, authenticated;
grant execute on function public.provision_first_library_admin(uuid) to service_role;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.create_library_profile();

create or replace function public.count_library_download()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
begin
  if new.action = 'downloaded' then
    update public.resources set downloads = downloads + 1 where id = new.resource_id;
  end if;
  return new;
end;
$$;

create trigger on_library_download
after insert on public.activity
for each row execute function public.count_library_download();

alter table public.profiles enable row level security;
alter table public.departments enable row level security;
alter table public.levels enable row level security;
alter table public.subjects enable row level security;
alter table public.resources enable row level security;
alter table public.favorites enable row level security;
alter table public.activity enable row level security;
alter table public.developers enable row level security;

create policy "Profiles are visible to their owner" on public.profiles
for select to authenticated using (id = (select auth.uid()) or public.is_library_admin());

create policy "Signed-in users can read departments" on public.departments
for select to authenticated using (true);
create policy "Administrators manage departments" on public.departments
for all to authenticated using (public.is_library_admin()) with check (public.is_library_admin());

create policy "Signed-in users can read levels" on public.levels
for select to authenticated using (true);
create policy "Administrators manage levels" on public.levels
for all to authenticated using (public.is_library_admin()) with check (public.is_library_admin());

create policy "Signed-in users can read subjects" on public.subjects
for select to authenticated using (true);
create policy "Administrators manage subjects" on public.subjects
for all to authenticated using (public.is_library_admin()) with check (public.is_library_admin());

create policy "Signed-in users can read library resources" on public.resources
for select to authenticated using (true);
create policy "Administrators manage resources" on public.resources
for all to authenticated using (public.is_library_admin()) with check (public.is_library_admin());

create policy "Users manage their own favorites" on public.favorites
for all to authenticated
using (user_id = (select auth.uid()))
with check (
  user_id = (select auth.uid()) and
  exists (select 1 from public.resources where id = resource_id and kind = 'book')
);
create policy "Administrators read favorites" on public.favorites
for select to authenticated using (public.is_library_admin());

create policy "Users read their own activity" on public.activity
for select to authenticated using (user_id = (select auth.uid()) or public.is_library_admin());
create policy "Users record their own activity" on public.activity
for insert to authenticated
with check (
  user_id = (select auth.uid()) and
  exists (select 1 from public.resources where id = resource_id)
);

create policy "Signed-in users can read developer profiles" on public.developers
for select to authenticated using (true);
create policy "Administrators manage developer profiles" on public.developers
for all to authenticated using (public.is_library_admin()) with check (public.is_library_admin());

insert into public.departments (name, sort_order) values
  ('Accounting', 1),
  ('Administrative Studies', 2),
  ('Automobile Mechanics', 3),
  ('Brick Laying', 4),
  ('Carpentry and Joinery', 5),
  ('Community Development', 6),
  ('Fabrication and Welding', 7),
  ('General Fitting', 8),
  ('Human Resource Management', 9),
  ('Information and Communication Technology', 10),
  ('Motorcycle Mechanics', 11),
  ('Procurement', 12),
  ('Public Health', 13)
on conflict do nothing;

insert into public.levels (department_id, name, sort_order)
select departments.id, 'Level ' || levels.number, levels.number
from public.departments
cross join generate_series(1, 4) as levels(number)
on conflict do nothing;

insert into public.developers (id, name, role, bio, accent, sort_order) values
  ('richard-cameron', 'Richard Cameron', 'Lead Developer & Systems Architect', 'Builds the library experience, product flow, and technical systems behind a smooth learning environment.', 'sage', 1),
  ('joshua', 'Joshua', 'Co-Developer & Product Partner', 'Helps shape the academic experience, feature planning, and student-first improvements across the platform.', 'gold', 2)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('books', 'books', false, 52428800, array[
    'application/pdf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain', 'text/rtf', 'application/rtf', 'text/csv', 'text/markdown',
    'application/vnd.ms-excel', 'application/epub+zip',
    'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation', 'image/jpeg', 'image/png'
  ]),
  ('videos', 'videos', false, 314572800, array['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v']),
  ('profile-photos', 'profile-photos', false, 5242880, array['image/jpeg', 'image/png'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "Authenticated users can read library files" on storage.objects
for select to authenticated using (bucket_id in ('books', 'videos', 'profile-photos'));
create policy "Administrators upload library files" on storage.objects
for insert to authenticated with check (bucket_id in ('books', 'videos', 'profile-photos') and public.is_library_admin());
create policy "Administrators update library files" on storage.objects
for update to authenticated
using (bucket_id in ('books', 'videos', 'profile-photos') and public.is_library_admin())
with check (bucket_id in ('books', 'videos', 'profile-photos') and public.is_library_admin());
create policy "Administrators delete library files" on storage.objects
for delete to authenticated using (bucket_id in ('books', 'videos', 'profile-photos') and public.is_library_admin());
