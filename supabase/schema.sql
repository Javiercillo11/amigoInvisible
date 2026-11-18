-- =====================================================================
--  AMIGO INVISIBLE · Esquema completo para Supabase
--  Ejecuta este archivo ENTERO en: Supabase > SQL Editor > New query > Run
--  Es idempotente: puedes ejecutarlo varias veces sin romper nada
--  (no borra respuestas ya guardadas).
-- =====================================================================
--
--  Modelo de seguridad
--  -------------------
--  * Las tablas viven en el esquema privado "amigo", que NO está expuesto
--    por la API REST de Supabase. Además tienen RLS activado SIN ninguna
--    política y se revocan todos los permisos a anon/authenticated:
--    triple barrera, nadie puede leerlas ni escribirlas desde el navegador.
--  * El navegador solo puede llamar a TRES funciones (RPC) del esquema
--    public, que se ejecutan en el servidor con SECURITY DEFINER:
--      - enviar_respuesta(p_device_id, p_nombre)  -> guarda un envío
--      - estado_dispositivo(p_device_id)          -> ¿este dispositivo ya envió?
--      - revelar_resultado(p_codigo)              -> solo Marisa, con su código
--    Ninguna de ellas devuelve nunca los nombres enviados por los demás.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

create schema if not exists amigo;
revoke all on schema amigo from public;
revoke all on schema amigo from anon, authenticated;

-- ---------------------------------------------------------------------
--  Normalización de nombres: minúsculas, sin tildes, sin espacios extra.
--  "  álvaro " -> "alvaro"
-- ---------------------------------------------------------------------
create or replace function amigo.normalizar(p_texto text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(
           translate(
             btrim(regexp_replace(coalesce(p_texto, ''), '\s+', ' ', 'g')),
             'ÁÀÄÂÃáàäâãÉÈËÊéèëêÍÌÏÎíìïîÓÒÖÔÕóòöôõÚÙÜÛúùüûÑñÇç',
             'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuNnCc'
           )
         );
$$;

-- ---------------------------------------------------------------------
--  Tablas
-- ---------------------------------------------------------------------

-- Lista cerrada de participantes (9 exactos).
create table if not exists amigo.participantes (
  nombre text primary key,
  clave  text not null unique,           -- nombre normalizado
  constraint clave_normalizada check (clave = amigo.normalizar(nombre))
);

insert into amigo.participantes (nombre, clave) values
  ('Alba',    'alba'),
  ('Javier',  'javier'),
  ('Alberto', 'alberto'),
  ('Rosa',    'rosa'),
  ('Marisa',  'marisa'),
  ('Antonio', 'antonio'),
  ('Alvaro',  'alvaro'),
  ('Adriana', 'adriana'),
  ('Charo',   'charo')
on conflict (nombre) do nothing;

-- Respuestas: una por dispositivo (UNIQUE en device_id).
-- El nombre debe existir en la lista (FOREIGN KEY).
create table if not exists amigo.respuestas (
  id         bigint generated always as identity primary key,
  device_id  uuid        not null,
  nombre     text        not null references amigo.participantes (nombre),
  creado_en  timestamptz not null default now(),
  constraint respuestas_device_unico unique (device_id)
);

-- Configuración (una sola fila): hash del código secreto de Marisa.
create table if not exists amigo.configuracion (
  id                 boolean primary key default true,
  codigo_marisa_hash text,
  constraint una_sola_fila check (id)
);
insert into amigo.configuracion (id) values (true) on conflict (id) do nothing;

-- Registro de intentos de revelación (para frenar ataques de fuerza bruta).
create table if not exists amigo.intentos_revelar (
  id        bigint generated always as identity primary key,
  correcto  boolean     not null,
  creado_en timestamptz not null default now()
);

-- ---------------------------------------------------------------------
--  RLS activado y SIN políticas => acceso directo denegado a todos
--  los roles de la API. Además, se revocan los permisos de tabla.
-- ---------------------------------------------------------------------
alter table amigo.participantes    enable row level security;
alter table amigo.respuestas       enable row level security;
alter table amigo.configuracion    enable row level security;
alter table amigo.intentos_revelar enable row level security;

revoke all on all tables    in schema amigo from public, anon, authenticated;
revoke all on all sequences in schema amigo from public, anon, authenticated;
revoke all on all functions in schema amigo from public, anon, authenticated;

-- Nota: las funciones SECURITY DEFINER de abajo se ejecutan como el dueño
-- de las tablas (postgres), que no está sujeto a RLS. Ningún otro rol tiene
-- acceso.

-- =====================================================================
--  FUNCIONES PÚBLICAS (RPC)
-- =====================================================================

-- ---------------------------------------------------------------------
--  enviar_respuesta: guarda el nombre elegido por un dispositivo.
--  Devuelve: {"ok": true,  "codigo": "guardada"}
--            {"ok": false, "codigo": "ya_enviado" | "nombre_vacio" |
--                          "nombre_no_valido" | "completo" |
--                          "dispositivo_invalido"}
-- ---------------------------------------------------------------------
create or replace function public.enviar_respuesta(p_device_id text, p_nombre text)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_device uuid;
  v_nombre text;
  v_total  integer;
begin
  -- 1. Identificador de dispositivo con formato UUID válido.
  if p_device_id is null
     or p_device_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return json_build_object('ok', false, 'codigo', 'dispositivo_invalido');
  end if;
  v_device := p_device_id::uuid;

  -- 2. Campo vacío.
  if p_nombre is null or btrim(p_nombre) = '' then
    return json_build_object('ok', false, 'codigo', 'nombre_vacio');
  end if;

  -- 3. Nombre de la lista cerrada (ignora mayúsculas, tildes y espacios).
  if length(p_nombre) > 60 then
    return json_build_object('ok', false, 'codigo', 'nombre_no_valido');
  end if;
  select p.nombre into v_nombre
    from amigo.participantes p
   where p.clave = amigo.normalizar(p_nombre);
  if v_nombre is null then
    return json_build_object('ok', false, 'codigo', 'nombre_no_valido');
  end if;

  -- 4. Serializa TODOS los envíos: dos envíos simultáneos se procesan
  --    uno detrás de otro (bloqueo que se libera al terminar la transacción).
  perform pg_advisory_xact_lock(hashtext('amigo_invisible.respuestas'));

  -- 5. Un único envío por dispositivo. No se indica qué nombre se envió
  --    para no filtrar información a quien coja un móvil ajeno.
  if exists (select 1 from amigo.respuestas r where r.device_id = v_device) then
    return json_build_object('ok', false, 'codigo', 'ya_enviado');
  end if;

  -- 6. Como máximo 8 respuestas (todos menos Marisa).
  select count(*) into v_total from amigo.respuestas;
  if v_total >= 8 then
    return json_build_object('ok', false, 'codigo', 'completo');
  end if;

  insert into amigo.respuestas (device_id, nombre) values (v_device, v_nombre);
  return json_build_object('ok', true, 'codigo', 'guardada');

exception
  -- Última red de seguridad: la restricción UNIQUE de la tabla.
  when unique_violation then
    return json_build_object('ok', false, 'codigo', 'ya_enviado');
end;
$$;

-- ---------------------------------------------------------------------
--  estado_dispositivo: ¿este dispositivo ya ha enviado su respuesta?
--  Devuelve: {"enviado": true|false}   (nunca el nombre)
-- ---------------------------------------------------------------------
create or replace function public.estado_dispositivo(p_device_id text)
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_device_id is null
     or p_device_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return json_build_object('enviado', false);
  end if;
  return json_build_object(
    'enviado',
    exists (select 1 from amigo.respuestas r where r.device_id = p_device_id::uuid)
  );
end;
$$;

-- ---------------------------------------------------------------------
--  revelar_resultado: SOLO para Marisa (requiere su código secreto).
--  Devuelve:
--    {"estado": "ok", "nombre": "..."}
--    {"estado": "incompleto", "registradas": X, "necesarias": 8}
--    {"estado": "codigo_incorrecto"} | {"estado": "bloqueado"}
--    {"estado": "error", "motivo": "..."}
-- ---------------------------------------------------------------------
create or replace function public.revelar_resultado(p_codigo text)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_hash          text;
  v_fallos        integer;
  v_participantes integer;
  v_total         integer;
  v_distintos     integer;
  v_huerfanos     integer;
  v_faltan        text[];
begin
  -- 1. ¿Está configurado el código de Marisa?
  select c.codigo_marisa_hash into v_hash from amigo.configuracion c where c.id;
  if v_hash is null then
    return json_build_object('estado', 'error', 'motivo', 'codigo_no_configurado');
  end if;

  -- 2. Freno a la fuerza bruta: máx. 15 fallos en 15 minutos (global).
  select count(*) into v_fallos
    from amigo.intentos_revelar i
   where not i.correcto and i.creado_en > now() - interval '15 minutes';
  if v_fallos >= 15 then
    return json_build_object('estado', 'bloqueado');
  end if;

  -- 3. Comprobación del código (bcrypt) con retardo en caso de fallo.
  if p_codigo is null
     or length(p_codigo) > 200
     or extensions.crypt(btrim(p_codigo), v_hash) <> v_hash then
    insert into amigo.intentos_revelar (correcto) values (false);
    perform pg_sleep(1.5);
    return json_build_object('estado', 'codigo_incorrecto');
  end if;
  insert into amigo.intentos_revelar (correcto) values (true);

  -- 4. Validaciones de integridad.
  select count(*) into v_participantes from amigo.participantes;
  if v_participantes <> 9
     or not exists (select 1 from amigo.participantes p where p.nombre = 'Marisa') then
    return json_build_object('estado', 'error', 'motivo', 'lista_participantes_alterada');
  end if;

  select count(*), count(distinct r.nombre)
    into v_total, v_distintos
    from amigo.respuestas r;

  if v_total < 8 then
    return json_build_object('estado', 'incompleto', 'registradas', v_total, 'necesarias', 8);
  end if;

  if v_total > 8 then
    return json_build_object('estado', 'error', 'motivo', 'demasiadas_respuestas');
  end if;

  if v_distintos <> 8 then
    return json_build_object('estado', 'error', 'motivo', 'nombres_duplicados');
  end if;

  select count(*) into v_huerfanos
    from amigo.respuestas r
   where not exists (select 1 from amigo.participantes p where p.nombre = r.nombre);
  if v_huerfanos > 0 then
    return json_build_object('estado', 'error', 'motivo', 'nombres_fuera_de_lista');
  end if;

  -- 5. Nombre de la lista que nadie ha elegido.
  select array_agg(p.nombre order by p.nombre) into v_faltan
    from amigo.participantes p
   where not exists (select 1 from amigo.respuestas r where r.nombre = p.nombre);

  if coalesce(array_length(v_faltan, 1), 0) <> 1 then
    return json_build_object('estado', 'error', 'motivo', 'resultado_no_unico');
  end if;

  -- Si el que falta es "Marisa", nadie le regala a Marisa y ella se
  -- regalaría a sí misma: el sorteo es incoherente.
  if v_faltan[1] = 'Marisa' then
    return json_build_object('estado', 'error', 'motivo', 'nadie_regala_a_marisa');
  end if;

  return json_build_object('estado', 'ok', 'nombre', v_faltan[1]);
end;
$$;

-- ---------------------------------------------------------------------
--  Permisos de ejecución: solo estas tres funciones, solo para la API.
-- ---------------------------------------------------------------------
revoke all on function public.enviar_respuesta(text, text)  from public;
revoke all on function public.estado_dispositivo(text)      from public;
revoke all on function public.revelar_resultado(text)       from public;

grant execute on function public.enviar_respuesta(text, text) to anon, authenticated;
grant execute on function public.estado_dispositivo(text)     to anon, authenticated;
grant execute on function public.revelar_resultado(text)      to anon, authenticated;

-- =====================================================================
--  ÚLTIMO PASO (OBLIGATORIO): define el código secreto de Marisa.
--  Ejecuta esto por separado, cambiando el texto por un código que
--  solo darás a Marisa (mejor 3 palabras, p. ej. 'estrella-turron-27'):
--
--  update amigo.configuracion
--     set codigo_marisa_hash = extensions.crypt('CAMBIA-ESTE-CODIGO', extensions.gen_salt('bf'))
--   where id;
-- =====================================================================
