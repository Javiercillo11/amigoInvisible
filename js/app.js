/* =====================================================================
   Amigo Invisible · Lógica del navegador
   Toda validación importante se repite en el servidor (Supabase RPC).
   Este archivo solo mejora la experiencia: nada de lo que hace aquí
   puede saltarse las reglas de la base de datos.
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.AMIGO_CONFIG || {};
  var PARTICIPANTES = ['Alba', 'Javier', 'Alberto', 'Rosa', 'Marisa', 'Antonio', 'Alvaro', 'Adriana', 'Charo'];
  var NECESARIAS = 8;
  var TIMEOUT_MS = 15000;

  var K_DEVICE = 'amigoInvisible.deviceId';
  var K_ENVIADO = 'amigoInvisible.enviado';
  var K_PENDIENTE = 'amigoInvisible.pendiente';
  var COOKIE_DEVICE = 'amigoInvisible_deviceId';
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    avisoConfig: $('avisoConfig'),
    marisaNo: $('marisaNo'),
    marisaSi: $('marisaSi'),
    panelParticipante: $('panelParticipante'),
    panelMarisa: $('panelMarisa'),
    form: $('formNombre'),
    nombre: $('nombre'),
    sugerencias: $('sugerencias'),
    errorNombre: $('errorNombre'),
    btnConfirmar: $('btnConfirmar'),
    yaEnviado: $('yaEnviado'),
    yaEnviadoTitulo: $('yaEnviadoTitulo'),
    yaEnviadoTexto: $('yaEnviadoTexto'),
    codigo: $('codigo'),
    btnDescubrir: $('btnDescubrir'),
    mensajeMarisa: $('mensajeMarisa'),
    modal: $('modal'),
    modalNombre: $('modalNombre'),
    btnCancelar: $('btnCancelar'),
    btnEnviar: $('btnEnviar'),
    reveal: $('reveal'),
    revealNombre: $('revealNombre'),
    btnCerrarReveal: $('btnCerrarReveal'),
    confeti: $('confeti'),
  };

  var ocupado = false;
  var nombreSeleccionado = null;
  var focoAntesDeModal = null;

  /* -------------------------------------------------------------------
     Utilidades
     ------------------------------------------------------------------- */
  function normalizar(texto) {
    return String(texto || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, ' ').trim().toLowerCase();
  }
  var MAPA_NOMBRES = {};
  PARTICIPANTES.forEach(function (n) { MAPA_NOMBRES[normalizar(n)] = n; });
  function nombreValido(texto) { return MAPA_NOMBRES[normalizar(texto)] || null; }

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* modo privado */ } }
  function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) { /* modo privado */ } }

  function cookieGet(nombre) {
    var partes = document.cookie ? document.cookie.split('; ') : [];
    for (var i = 0; i < partes.length; i++) {
      var idx = partes[i].indexOf('=');
      if (partes[i].slice(0, idx) === nombre) return decodeURIComponent(partes[i].slice(idx + 1));
    }
    return null;
  }
  function cookieSet(nombre, valor) {
    document.cookie = nombre + '=' + encodeURIComponent(valor) +
      '; Max-Age=31536000; Path=/; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
  }

  function nuevoUUID() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    var b = window.crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  /* Identificador persistente del dispositivo: se guarda en localStorage
     Y en una cookie de 1 año. Si se borra uno, se recupera del otro. */
  function obtenerDeviceId() {
    var id = lsGet(K_DEVICE);
    if (!UUID_RE.test(id || '')) id = cookieGet(COOKIE_DEVICE);
    if (!UUID_RE.test(id || '')) id = nuevoUUID();
    lsSet(K_DEVICE, id);
    cookieSet(COOKIE_DEVICE, id);
    return id;
  }

  function configurado() {
    return /^https:\/\/.+/.test(CFG.SUPABASE_URL || '') &&
      !/TU-PROYECTO/.test(CFG.SUPABASE_URL) &&
      !!CFG.SUPABASE_ANON_KEY && !/TU-CLAVE/.test(CFG.SUPABASE_ANON_KEY);
  }

  /* Llamada a una función RPC de Supabase (PostgREST). */
  function rpc(funcion, params) {
    var url = String(CFG.SUPABASE_URL).replace(/\/+$/, '') + '/rest/v1/rpc/' + funcion;
    var headers = { 'Content-Type': 'application/json', apikey: CFG.SUPABASE_ANON_KEY };
    // Las claves antiguas (JWT "eyJ...") van también como Bearer; las nuevas
    // "sb_publishable_..." solo en la cabecera apikey.
    if (CFG.SUPABASE_ANON_KEY.indexOf('sb_') !== 0) headers.Authorization = 'Bearer ' + CFG.SUPABASE_ANON_KEY;

    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;

    return fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(params || {}),
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (res) {
      if (!res.ok) {
        var err = new Error('HTTP ' + res.status);
        err.tipo = 'servidor';
        throw err;
      }
      return res.json();
    }, function () {
      var err = new Error('Sin conexión');
      err.tipo = 'red';
      throw err;
    }).finally(function () {
      if (timer) clearTimeout(timer);
    });
  }

  function setCargando(boton, cargando, textoNormal) {
    boton.disabled = cargando;
    boton.setAttribute('aria-busy', cargando ? 'true' : 'false');
    boton.innerHTML = cargando
      ? '<span class="spinner" aria-hidden="true"></span><span>Un momento…</span>'
      : textoNormal;
  }

  function sacudir(nodo) {
    nodo.classList.remove('temblor');
    void nodo.offsetWidth;
    nodo.classList.add('temblor');
  }

  /* -------------------------------------------------------------------
     Selector "¿Eres Marisa?"
     ------------------------------------------------------------------- */
  function actualizarModo() {
    var esMarisa = el.marisaSi.checked;
    el.panelParticipante.hidden = esMarisa;
    el.panelMarisa.hidden = !esMarisa;
    cerrarSugerencias();
    if (!esMarisa) mostrarMensajeMarisa(null);
  }

  /* -------------------------------------------------------------------
     Autocompletado (solo nombres de la lista)
     ------------------------------------------------------------------- */
  var indiceActivo = -1;

  function pintarSugerencias() {
    var q = normalizar(el.nombre.value);
    var lista = PARTICIPANTES.filter(function (n) {
      return !q || normalizar(n).indexOf(q) === 0;
    });
    if (lista.length === 1 && normalizar(lista[0]) === q) lista = [];

    el.sugerencias.innerHTML = '';
    indiceActivo = -1;
    lista.forEach(function (n, i) {
      var li = document.createElement('li');
      li.id = 'sug-' + i;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.textContent = n;
      li.addEventListener('mousedown', function (e) { e.preventDefault(); });
      li.addEventListener('click', function () { elegirSugerencia(n); });
      el.sugerencias.appendChild(li);
    });
    var abierto = lista.length > 0 && document.activeElement === el.nombre;
    el.sugerencias.hidden = !abierto;
    el.nombre.setAttribute('aria-expanded', abierto ? 'true' : 'false');
    el.nombre.removeAttribute('aria-activedescendant');
  }

  function cerrarSugerencias() {
    el.sugerencias.hidden = true;
    el.nombre.setAttribute('aria-expanded', 'false');
    el.nombre.removeAttribute('aria-activedescendant');
    indiceActivo = -1;
  }

  function elegirSugerencia(n) {
    el.nombre.value = n;
    limpiarErrorNombre();
    cerrarSugerencias();
  }

  function moverActivo(delta) {
    var items = el.sugerencias.querySelectorAll('li');
    if (!items.length) return;
    if (indiceActivo >= 0) items[indiceActivo].setAttribute('aria-selected', 'false');
    indiceActivo = (indiceActivo + delta + items.length) % items.length;
    items[indiceActivo].setAttribute('aria-selected', 'true');
    items[indiceActivo].scrollIntoView({ block: 'nearest' });
    el.nombre.setAttribute('aria-activedescendant', items[indiceActivo].id);
  }

  function errorNombre(texto) {
    el.errorNombre.textContent = texto;
    el.nombre.setAttribute('aria-invalid', 'true');
    sacudir(el.nombre);
  }
  function limpiarErrorNombre() {
    el.errorNombre.textContent = '';
    el.nombre.removeAttribute('aria-invalid');
  }

  /* -------------------------------------------------------------------
     Estado "ya enviado"
     ------------------------------------------------------------------- */
  function mostrarEnviado(titulo, texto) {
    el.form.hidden = true;
    el.yaEnviado.hidden = false;
    el.yaEnviadoTitulo.textContent = titulo;
    el.yaEnviadoTexto.textContent = texto;
  }
  function mostrarFormulario() {
    el.form.hidden = false;
    el.yaEnviado.hidden = true;
  }

  var TXT_OK_TITULO = '¡Perfecto!';
  var TXT_OK = 'Tu respuesta se ha guardado correctamente. Ya no puedes modificarla.';
  var TXT_YA_TITULO = 'Respuesta ya enviada';
  var TXT_YA = 'Este dispositivo ya ha enviado su respuesta y no puede enviar otra. ¡Gracias por participar!';

  /* Al cargar: el servidor es la fuente de verdad. */
  function comprobarEstado() {
    var pendiente = lsGet(K_PENDIENTE);
    if (lsGet(K_ENVIADO) === '1') mostrarEnviado(TXT_YA_TITULO, TXT_YA);
    if (!configurado()) return Promise.resolve();

    return rpc('estado_dispositivo', { p_device_id: deviceId }).then(function (r) {
      if (r && r.enviado) {
        lsSet(K_ENVIADO, '1');
        lsDel(K_PENDIENTE);
        // Si había un envío pendiente (se cortó la conexión) y llegó: éxito.
        if (pendiente) mostrarEnviado(TXT_OK_TITULO, TXT_OK);
        else mostrarEnviado(TXT_YA_TITULO, TXT_YA);
      } else {
        lsDel(K_ENVIADO);
        mostrarFormulario();
        if (pendiente) {
          lsDel(K_PENDIENTE);
          el.nombre.value = nombreValido(pendiente) || '';
          el.errorNombre.textContent = 'Tu envío anterior no llegó a guardarse. Pulsa CONFIRMAR para intentarlo de nuevo.';
        }
      }
    }).catch(function () {
      // Sin conexión al cargar: se mantiene lo que sepa el navegador.
      // Aunque se muestre el formulario, el servidor rechazará un 2.º envío.
    });
  }

  /* -------------------------------------------------------------------
     Envío del nombre
     ------------------------------------------------------------------- */
  function alConfirmar(e) {
    e.preventDefault();
    if (ocupado) return;
    cerrarSugerencias();

    if (!configurado()) { errorNombre('La aplicación no está configurada todavía.'); return; }

    var valor = el.nombre.value;
    if (!valor.trim()) { errorNombre('Escribe el nombre de la persona a la que le haces el regalo.'); el.nombre.focus(); return; }

    var nombre = nombreValido(valor);
    if (!nombre) { errorNombre('«' + valor.trim().slice(0, 30) + '» no está en la lista. Elige uno de los nombres sugeridos.'); el.nombre.focus(); return; }

    limpiarErrorNombre();
    el.nombre.value = nombre;
    nombreSeleccionado = nombre;
    abrirModal(nombre);
  }

  function abrirModal(nombre) {
    focoAntesDeModal = document.activeElement;
    el.modalNombre.textContent = nombre;
    el.modal.hidden = false;
    document.body.style.overflow = 'hidden';
    el.btnCancelar.focus();
  }
  function cerrarModal() {
    if (ocupado) return;
    el.modal.hidden = true;
    document.body.style.overflow = '';
    if (focoAntesDeModal && focoAntesDeModal.focus) focoAntesDeModal.focus();
  }

  function enviar() {
    if (ocupado || !nombreSeleccionado) return;
    ocupado = true;
    setCargando(el.btnEnviar, true);
    el.btnCancelar.disabled = true;
    lsSet(K_PENDIENTE, nombreSeleccionado);

    rpc('enviar_respuesta', { p_device_id: deviceId, p_nombre: nombreSeleccionado })
      .then(function (r) {
        var codigo = r && r.codigo;
        if (r && r.ok) {
          lsSet(K_ENVIADO, '1');
          lsDel(K_PENDIENTE);
          terminarEnvio();
          mostrarEnviado(TXT_OK_TITULO, TXT_OK);
          return;
        }
        if (codigo === 'ya_enviado') {
          lsSet(K_ENVIADO, '1');
          lsDel(K_PENDIENTE);
          terminarEnvio();
          mostrarEnviado(TXT_YA_TITULO, TXT_YA);
          return;
        }
        lsDel(K_PENDIENTE);
        terminarEnvio();
        if (codigo === 'nombre_vacio') errorNombre('Escribe un nombre antes de confirmar.');
        else if (codigo === 'nombre_no_valido') errorNombre('Ese nombre no está en la lista de participantes.');
        else if (codigo === 'completo') errorNombre('Ya se han recibido las 8 respuestas. Si tú aún no habías enviado la tuya, avisa al organizador: alguien puede haber enviado dos veces.');
        else errorNombre('No se ha podido guardar tu respuesta. Inténtalo de nuevo en unos segundos.');
      })
      .catch(function (err) {
        terminarEnvio();
        if (err.tipo === 'red') {
          // Mantenemos K_PENDIENTE: al recuperar conexión o recargar se
          // comprueba en el servidor si el envío llegó a guardarse.
          errorNombre('No hay conexión o el servidor no responde. Comprueba tu conexión y pulsa CONFIRMAR de nuevo. Si tu respuesta ya llegó, no se duplicará.');
        } else {
          lsDel(K_PENDIENTE);
          errorNombre('El servidor ha devuelto un error. Inténtalo de nuevo en unos segundos.');
        }
      });
  }

  function terminarEnvio() {
    ocupado = false;
    setCargando(el.btnEnviar, false, 'CONFIRMAR');
    el.btnCancelar.disabled = false;
    cerrarModal();
  }

  /* -------------------------------------------------------------------
     Marisa
     ------------------------------------------------------------------- */
  var MOTIVOS = {
    codigo_no_configurado: 'El organizador todavía no ha configurado tu código secreto.',
    lista_participantes_alterada: 'La lista de participantes de la base de datos no es correcta.',
    demasiadas_respuestas: 'Hay más respuestas de las posibles.',
    nombres_duplicados: 'Hay nombres repetidos entre las respuestas: alguien se ha equivocado o ha enviado dos veces.',
    nombres_fuera_de_lista: 'Hay respuestas con nombres que no están en la lista.',
    resultado_no_unico: 'No se puede determinar un único nombre.',
    nadie_regala_a_marisa: 'Nadie ha indicado que te regala a ti, así que las respuestas no cuadran.',
  };

  function mostrarMensajeMarisa(html, tipo) {
    if (!html) { el.mensajeMarisa.hidden = true; el.mensajeMarisa.innerHTML = ''; return; }
    el.mensajeMarisa.className = 'notice' + (tipo ? ' notice-' + tipo : '');
    el.mensajeMarisa.innerHTML = html;
    el.mensajeMarisa.hidden = false;
  }

  function descubrir() {
    if (ocupado) return;
    if (!configurado()) { mostrarMensajeMarisa('La aplicación no está configurada todavía.', 'error'); return; }
    var codigo = el.codigo.value.trim();
    if (!codigo) {
      mostrarMensajeMarisa('Introduce tu código secreto.', 'error');
      sacudir(el.codigo);
      el.codigo.focus();
      return;
    }

    ocupado = true;
    setCargando(el.btnDescubrir, true);
    mostrarMensajeMarisa(null);

    rpc('revelar_resultado', { p_codigo: codigo })
      .then(function (r) {
        var estado = r && r.estado;
        if (estado === 'ok' && r.nombre && PARTICIPANTES.indexOf(r.nombre) !== -1 && r.nombre !== 'Marisa') {
          mostrarRevelacion(r.nombre);
        } else if (estado === 'incompleto') {
          var x = Math.max(0, Math.min(NECESARIAS, Number(r.registradas) || 0));
          mostrarMensajeMarisa(
            'Todavía no están todos los participantes. Espera a que los demás introduzcan su respuesta.' +
            '<br><strong>Respuestas registradas: ' + x + '/' + NECESARIAS + '.</strong>' +
            '<div class="progress" aria-hidden="true"><span style="transform:scaleX(' + (x / NECESARIAS) + ')"></span></div>',
            'wait'
          );
        } else if (estado === 'codigo_incorrecto') {
          mostrarMensajeMarisa('El código no es correcto. Revísalo y vuelve a intentarlo.', 'error');
          sacudir(el.codigo);
        } else if (estado === 'bloqueado') {
          mostrarMensajeMarisa('Demasiados intentos fallidos. Espera 15 minutos antes de volver a intentarlo.', 'error');
        } else if (estado === 'error') {
          mostrarMensajeMarisa(
            '<strong>No se puede revelar el resultado.</strong><br>' +
            (MOTIVOS[r.motivo] || 'Se ha detectado una anomalía en los datos.') +
            '<br>Avisa al organizador para que lo revise.',
            'error'
          );
        } else {
          mostrarMensajeMarisa('Respuesta inesperada del servidor. No se revela ningún resultado.', 'error');
        }
      })
      .catch(function (err) {
        mostrarMensajeMarisa(err.tipo === 'red'
          ? 'No hay conexión o el servidor no responde. Comprueba tu conexión y vuelve a intentarlo.'
          : 'El servidor ha devuelto un error. Inténtalo de nuevo en unos segundos.', 'error');
      })
      .finally(function () {
        ocupado = false;
        setCargando(el.btnDescubrir, false, 'DESCUBRIR QUIÉN TE HA TOCADO');
      });
  }

  /* -------------------------------------------------------------------
     Revelación + confeti
     ------------------------------------------------------------------- */
  var reducirMovimiento = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function mostrarRevelacion(nombre) {
    el.revealNombre.textContent = nombre;
    el.reveal.classList.remove('abierto');
    el.reveal.hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(function () {
      el.reveal.classList.add('abierto');
      el.btnCerrarReveal.focus();
      if (!reducirMovimiento) lanzarConfeti();
    }, reducirMovimiento ? 0 : 1400);
  }

  function cerrarRevelacion() {
    el.reveal.hidden = true;
    el.reveal.classList.remove('abierto');
    document.body.style.overflow = '';
    detenerConfeti = true;
  }

  var detenerConfeti = false;
  function lanzarConfeti() {
    var c = el.confeti;
    var ctx = c.getContext('2d');
    if (!ctx) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = c.width = window.innerWidth * dpr;
    var h = c.height = window.innerHeight * dpr;
    var colores = ['#e2c27a', '#cfa54e', '#b3202e', '#fffcf5', '#2f7d5c'];
    var piezas = [];
    for (var i = 0; i < 170; i++) {
      piezas.push({
        x: w / 2 + (Math.random() - 0.5) * w * 0.2,
        y: h * 0.42,
        vx: (Math.random() - 0.5) * 16 * dpr,
        vy: (-Math.random() * 15 - 6) * dpr,
        s: (Math.random() * 6 + 5) * dpr,
        r: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        c: colores[i % colores.length],
        forma: Math.random() < 0.3 ? 'c' : 'r',
      });
    }
    var inicio = performance.now();
    detenerConfeti = false;
    (function frame(t) {
      var dt = t - inicio;
      ctx.clearRect(0, 0, w, h);
      piezas.forEach(function (p) {
        p.vy += 0.35 * dpr;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.r += p.vr;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - dt / 6000);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        if (p.forma === 'c') { ctx.beginPath(); ctx.arc(0, 0, p.s / 2.5, 0, Math.PI * 2); ctx.fill(); }
        else ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
        ctx.restore();
      });
      if (dt < 6000 && !detenerConfeti) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, w, h);
    })(inicio);
  }

  /* -------------------------------------------------------------------
     Nieve decorativa
     ------------------------------------------------------------------- */
  function crearNieve() {
    if (reducirMovimiento) return;
    var cont = $('snow');
    for (var i = 0; i < 28; i++) {
      var s = document.createElement('span');
      var tam = Math.random() * 4 + 2;
      s.style.left = Math.random() * 100 + 'vw';
      s.style.width = s.style.height = tam + 'px';
      s.style.opacity = (Math.random() * 0.5 + 0.25).toFixed(2);
      s.style.animationDuration = (Math.random() * 10 + 10).toFixed(1) + 's';
      s.style.animationDelay = (-Math.random() * 20).toFixed(1) + 's';
      s.style.setProperty('--deriva', ((Math.random() - 0.5) * 80).toFixed(0) + 'px');
      cont.appendChild(s);
    }
  }

  /* -------------------------------------------------------------------
     Arranque
     ------------------------------------------------------------------- */
  var deviceId = obtenerDeviceId();

  if (!configurado()) el.avisoConfig.hidden = false;

  el.marisaNo.addEventListener('change', actualizarModo);
  el.marisaSi.addEventListener('change', actualizarModo);

  el.form.addEventListener('submit', alConfirmar);
  el.nombre.addEventListener('input', function () { limpiarErrorNombre(); pintarSugerencias(); });
  el.nombre.addEventListener('focus', pintarSugerencias);
  el.nombre.addEventListener('blur', function () {
    setTimeout(function () { if (document.activeElement !== el.nombre) cerrarSugerencias(); }, 120);
  });
  el.nombre.addEventListener('keydown', function (e) {
    if (el.sugerencias.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); moverActivo(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moverActivo(-1); }
    else if (e.key === 'Escape') { cerrarSugerencias(); }
    else if (e.key === 'Enter' && indiceActivo >= 0) {
      e.preventDefault();
      elegirSugerencia(el.sugerencias.querySelectorAll('li')[indiceActivo].textContent);
    }
  });

  el.btnEnviar.addEventListener('click', enviar);
  Array.prototype.forEach.call(el.modal.querySelectorAll('[data-cerrar]'), function (n) {
    n.addEventListener('click', cerrarModal);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !el.modal.hidden) cerrarModal();
    if (e.key === 'Tab' && !el.modal.hidden) {           // foco atrapado en el modal
      var a = el.btnCancelar, b = el.btnEnviar;
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
      else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
    }
  });

  el.btnDescubrir.addEventListener('click', descubrir);
  el.codigo.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); descubrir(); } });
  el.btnCerrarReveal.addEventListener('click', cerrarRevelacion);

  // Al recuperar la conexión, comprobamos si un envío pendiente llegó.
  window.addEventListener('online', function () { if (lsGet(K_PENDIENTE) && !ocupado) comprobarEstado(); });
  // Al volver a la pestaña (p. ej. tras usar otro navegador), refrescamos.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && !ocupado) comprobarEstado();
  });

  actualizarModo();
  crearNieve();
  comprobarEstado();
})();
