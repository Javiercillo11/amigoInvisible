-- =====================================================================
--  AMIGO INVISIBLE · Consultas de administración (solo para el organizador)
--  Ejecútalas una a una en Supabase > SQL Editor.
--
--  ⚠️  AVISO DE PRIVACIDAD: quien tiene acceso al panel de Supabase PUEDE
--  ver todas las respuestas. Las consultas de este archivo están pensadas
--  para NO mostrarte los nombres. Evita abrir la tabla amigo.respuestas
--  en el Table Editor si tú también participas.
-- =====================================================================

-- 1) Definir o cambiar el código secreto de Marisa
update amigo.configuracion
   set codigo_marisa_hash = extensions.crypt('CAMBIA-ESTE-CODIGO', extensions.gen_salt('bf'))
 where id;

-- 2) ¿Cuántas respuestas hay? (sin ver los nombres)
select count(*) as respuestas_registradas, 8 as necesarias from amigo.respuestas;

-- 3) Diagnóstico sin desvelar nombres: ¿hay duplicados?
select count(*)                                  as total,
       count(distinct nombre)                    as nombres_distintos,
       count(*) - count(distinct nombre)         as duplicados,
       bool_or(nombre = 'Marisa')                as alguien_regala_a_marisa
  from amigo.respuestas;

-- 4) Hora de cada envío (sin nombres): útil para detectar envíos sospechosos
select id, creado_en from amigo.respuestas order by creado_en;

-- 5) Intentos de revelación fallidos en la última hora
select count(*) filter (where not correcto) as fallidos,
       count(*) filter (where correcto)     as correctos
  from amigo.intentos_revelar
 where creado_en > now() - interval '1 hour';

-- 6) Desbloquear la revelación si alguien ha forzado el bloqueo por intentos
delete from amigo.intentos_revelar where not correcto;

-- 7) Borrar UNA respuesta concreta (p. ej. un envío duplicado detectado por
--    su hora en la consulta 4). Sustituye 123 por el id.
-- delete from amigo.respuestas where id = 123;

-- 8) REINICIAR TODO (borra todas las respuestas). Irreversible.
-- truncate amigo.respuestas restart identity;
-- truncate amigo.intentos_revelar restart identity;
