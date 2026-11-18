# 🎁 Amigo Invisible: ¿a quién le regala Marisa?

Aplicación web para móviles que resuelve un problema concreto: en un amigo invisible de 9 personas, **Marisa no sabe a quién le tiene que regalar**.

Cada uno de los otros 8 participantes introduce a quién le regala. Cuando están las 8 respuestas, el único nombre de la lista que **nadie** ha escrito es el de la persona a la que tiene que regalar Marisa. Marisa (y solo ella, con su código secreto) puede descubrirlo.

- **Frontend:** HTML, CSS y JavaScript sin dependencias, alojado en **GitHub Pages**.
- **Backend y base de datos:** **Supabase** (PostgreSQL, plan gratuito). La lógica sensible está en funciones SQL que se ejecutan en el servidor.

---

## 1. Estructura del proyecto

```
amigoInvisible/
├── index.html            # Única página de la app
├── css/styles.css        # Estilos (navideño, mobile-first)
├── js/config.js          # ← AQUÍ pones la URL y la clave pública de Supabase
├── js/app.js             # Lógica del navegador
├── supabase/schema.sql   # Tablas, restricciones, RLS y funciones backend
├── supabase/admin.sql    # Consultas útiles para el organizador
├── .nojekyll             # Indica a GitHub Pages que sirva los archivos tal cual
└── README.md
```

---

## 2. Arquitectura y seguridad

```
Móvil (navegador) ──HTTPS──▶ Supabase API ──▶ 3 funciones SQL (SECURITY DEFINER) ──▶ tablas privadas
                              (clave pública)    enviar_respuesta                         esquema "amigo"
                                                 estado_dispositivo                       (sin acceso directo)
                                                 revelar_resultado
```

| Requisito | Cómo se cumple |
|---|---|
| Nadie puede leer las respuestas | Las tablas están en el esquema `amigo`, que la API **no expone**. Además tienen **RLS activado sin ninguna política** y se revocan todos los permisos a `anon`/`authenticated`. Probado: un `select` como `anon` devuelve `permission denied`. |
| Nadie puede deducir quién falta | Ninguna función devuelve nombres. `enviar_respuesta` responde igual (`ya_enviado`) sin indicar qué se envió. Solo `revelar_resultado` devuelve un nombre, y exige el **código secreto de Marisa**. |
| Claves privadas fuera del frontend | El frontend solo lleva la clave **pública** (`anon`/`publishable`), pensada para estar en el navegador. Con ella solo se pueden ejecutar esas 3 funciones. La `service_role`/`secret` no se usa en ningún sitio. |
| Validación en el servidor | Nombre vacío, nombre fuera de lista, un envío por dispositivo, máximo 8 respuestas: todo se comprueba en PostgreSQL. El JavaScript solo repite las comprobaciones para dar mensajes inmediatos. |
| Envíos simultáneos | La función toma un **bloqueo transaccional** (`pg_advisory_xact_lock`) y los envíos se procesan de uno en uno. Además hay una restricción `UNIQUE(device_id)`. Probado: 20 envíos simultáneos del mismo dispositivo guardan **1** fila; 15 dispositivos a la vez guardan **8**. |
| Revelación segura | `revelar_resultado` comprueba en el servidor que hay exactamente 9 participantes, exactamente 8 respuestas y 8 nombres distintos, que todos están en la lista, que solo falta 1 nombre y que ese nombre no es «Marisa». Si algo falla, **no revela nada**. |
| Fuerza bruta contra el código | Cada código erróneo espera 1,5 s y queda registrado. Tras 15 fallos en 15 minutos, la revelación se bloquea temporalmente. |

### ¿Por qué un código secreto para Marisa?

El planteamiento original permitía que **cualquiera** marcara «Sí, soy Marisa» y pulsara el botón. Entonces cualquier participante podría descubrir a quién regala Marisa, cosa que contradice el requisito de privacidad. Por eso, en modo Marisa hay que escribir un código que el organizador le da **solo a ella**. Es la mínima fricción posible para cumplir el requisito.

### ⚠️ El problema de «un envío por móvil» (léelo)

**Un navegador web no puede identificar un dispositivo físico de forma fiable.** No existe ninguna API para leer un identificador del móvil, y es intencionado, por privacidad. Cualquier identificador que use una web (cookie, localStorage, IndexedDB, *fingerprinting*) se pierde o cambia si el usuario:

- abre la web en **otro navegador** del mismo móvil (Chrome ↔ Safari),
- usa el **modo incógnito**,
- **borra los datos** del navegador,
- usa **otro dispositivo**.

El *fingerprinting* (huella del navegador) tampoco sirve: dos iPhone del mismo modelo dan prácticamente la misma huella, así que bloquearía a personas legítimas. Además, plantea problemas legales (RGPD).

**Qué hace esta aplicación (lo máximo razonable sin pedir datos personales):**

1. Genera un identificador aleatorio (UUID) y lo guarda **en localStorage y en una cookie de 1 año**. Si se borra uno, se recupera del otro.
2. El **servidor** rechaza un segundo envío con ese identificador (`UNIQUE` + bloqueo). Recargar la página, cerrar el navegador o pulsar dos veces no permite enviar otra vez.
3. **Tope global de 8 respuestas** en el servidor. Si alguien hace trampa desde incógnito, como mucho ocupa un hueco. El último participante legítimo verá «Ya se han recibido las 8 respuestas… avisa al organizador» y el fraude **se detecta**.
4. Si alguien envía un nombre repetido, Marisa **no** verá un resultado incorrecto: verá un error de «nombres duplicados».

En resumen: un error involuntario es imposible, y una trampa deliberada **se detecta** aunque no se pueda impedir del todo. Para un amigo invisible entre familiares o amigos es la solución adecuada. Bloquear de verdad a una persona exigiría identificarla, por ejemplo con un código personal por participante o un inicio de sesión. Eso complica el uso y obliga a guardar quién regala a quién.

---

## 3. Configurar Supabase desde cero (≈10 minutos)

1. Entra en <https://supabase.com> y crea una cuenta gratuita (puedes usar GitHub).
2. **New project**: ponle un nombre (p. ej. `amigo-invisible`), una contraseña de base de datos (guárdala) y la región más cercana (p. ej. *West EU*). Espera 1–2 minutos a que se cree.
3. Ve a **SQL Editor → New query**, pega **todo** el contenido de [`supabase/schema.sql`](supabase/schema.sql) y pulsa **Run**. Debe terminar con «Success».
4. **Define el código secreto de Marisa.** En una nueva query, ejecuta (cambiando el código):
   ```sql
   update amigo.configuracion
      set codigo_marisa_hash = extensions.crypt('estrella-turron-27', extensions.gen_salt('bf'))
    where id;
   ```
   Usa algo fácil de escribir pero difícil de adivinar (2–3 palabras y un número). Dáselo **solo a Marisa**, en persona o por mensaje privado. El código se guarda cifrado (bcrypt).
5. Ve a **Project Settings → API** (o **API Keys**) y copia:
   - **Project URL** → `https://xxxxxxxx.supabase.co`
   - La clave **pública**: `anon public` (empieza por `eyJ…`) o `publishable` (empieza por `sb_publishable_…`).

   ⛔ **No copies** la `service_role` ni la `secret`.
6. Abre [`js/config.js`](js/config.js) y pega los dos valores:
   ```js
   window.AMIGO_CONFIG = {
     SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
     SUPABASE_ANON_KEY: 'eyJhbGciOi...',
   };
   ```

> No hay que tocar *Authentication*, *Storage* ni crear Edge Functions: las tres funciones SQL son el backend completo.

---

## 4. Publicar en GitHub Pages

1. Sube el proyecto a un repositorio de GitHub (puede ser público; la clave de `config.js` es pública por diseño):
   ```bash
   git add .
   git commit -m "Amigo invisible"
   git remote add origin https://github.com/TU-USUARIO/amigoInvisible.git   # si aún no existe
   git push -u origin main
   ```
2. En GitHub: **Settings → Pages → Build and deployment**
   - *Source*: **Deploy from a branch**
   - *Branch*: **main** / carpeta **/ (root)** → **Save**
3. En 1–2 minutos la web estará en `https://TU-USUARIO.github.io/amigoInvisible/`.
4. Ábrela en tu móvil y comprueba que **no** aparece el aviso rojo de «La aplicación todavía no está configurada».
5. Comparte el enlace por el grupo. Dale a Marisa su código por privado.

### Probar en local (opcional)

```bash
python3 -m http.server 8000
# abre http://localhost:8000
```

---

## 5. Uso

**Participantes (todos menos Marisa):** abren el enlace, dejan «¿Eres Marisa?» en **No**, escriben o eligen a quién regalan, pulsan **CONFIRMAR** y confirman en la ventana. Listo.

**Marisa:** abre el enlace, marca **Sí**, escribe su código y pulsa **DESCUBRIR QUIÉN TE HA TOCADO**. Si faltan respuestas, verá cuántas hay (X/8) y podrá volver a intentarlo más tarde.

---

## 6. Casos controlados

Todos se han probado contra PostgreSQL real (como el rol `anon` de Supabase) y en un navegador de móvil simulado.

| Caso | Comportamiento |
|---|---|
| Un participante intenta enviar dos veces | El formulario desaparece tras enviar. Si lo fuerza, el servidor responde `ya_enviado` y se muestra «Este dispositivo ya ha enviado su respuesta». |
| Dos personas envían a la vez | Bloqueo transaccional en el servidor: se procesan una tras otra y nunca se superan las 8. |
| Doble pulsación / dos pestañas | Botón desactivado durante el envío + `UNIQUE(device_id)` en la base de datos. |
| Nombre que no está en la lista | Rechazado en el navegador y en el servidor (`nombre_no_valido`). No distingue mayúsculas, tildes ni espacios: «álvaro » = «Alvaro». |
| Campo vacío | Rechazado en el navegador y en el servidor (`nombre_vacio`). |
| Marisa lo intenta antes de tiempo | «Todavía no están todos los participantes… Respuestas registradas: X/8.» con barra de progreso. |
| 8 respuestas con nombres duplicados | Error «Hay nombres repetidos…». No revela nada. |
| Datos inconsistentes | Más de 8 respuestas, lista alterada, nombres fuera de lista, nadie regala a Marisa, más de un nombre sin elegir: error, sin revelar nada. |
| Recargar después de enviar | El servidor confirma que ese dispositivo ya envió y se muestra «Respuesta ya enviada». |
| Acceder desde otro navegador | Ver [§2](#️-el-problema-de-un-envío-por-móvil-léelo). Ese navegador tiene otro identificador. Si alguien lo usa para enviar de más, el tope de 8 y la validación de duplicados lo detectan. |
| Se pierde la conexión al enviar | Mensaje claro. Se recuerda el envío pendiente y, al recuperar la conexión o recargar, se pregunta al servidor si llegó. Reintentar nunca duplica. |
| Código de Marisa incorrecto | «El código no es correcto» (con retardo de 1,5 s). Tras 15 fallos en 15 min, bloqueo temporal. |

---

## 7. Administración (organizador)

En [`supabase/admin.sql`](supabase/admin.sql) tienes consultas para ver **cuántas** respuestas hay sin ver los nombres, diagnosticar duplicados, desbloquear la revelación, borrar un envío erróneo o reiniciarlo todo.

⚠️ **Privacidad del organizador:** quien tenga acceso al panel de Supabase *puede* ver la tabla `amigo.respuestas`. Si participas, **no abras esa tabla en el Table Editor** y usa solo las consultas de `admin.sql`, que no muestran nombres.

---

## 8. Limitaciones a tener en cuenta

- **Pausa del plan gratuito:** Supabase pausa los proyectos gratuitos tras **7 días sin actividad**. Si ocurre, entra al panel y pulsa **Restore project**. Los datos se conservan.
- **Identificación de dispositivos:** ver [§2](#️-el-problema-de-un-envío-por-móvil-léelo).
- **Navegadores:** funciona en cualquier navegador móvil actual (Safari iOS 14+, Chrome, Firefox, Samsung Internet). Necesita HTTPS, que GitHub Pages ya proporciona.
