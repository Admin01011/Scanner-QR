(() => {
  'use strict';

  const CONFIG = window.LAE_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const AUTH_SESSION_KEY = 'laeScanner.googleAccessSession.v1';
  const LEGACY_AUTH_MARKER_KEY = 'laeScanner.googleAuthorizationRemembered.v1';

  const state = {
    accessToken: null,
    tokenExpiresAt: 0,
    tokenClient: null,
    scanner: null,
    scanning: false,
    saving: false,
    uncertainWrite: false,
    guide: '',
    duplicateGuide: null,
    scannedGuides: new Map(),
    guideMemoryDateKey: '',
    authPending: false,
    authMode: 'user',
    pendingSaveAfterAuth: false,
    connected: false,
    restoringSession: false,
    autoRestartTimer: null
  };

  const elements = {
    connectionBadge: $('connectionBadge'),
    connectionText: $('connectionText'),
    connectionCard: $('connectionCard'),
    connectionDetail: $('connectionDetail'),
    connectionFeedback: $('connectionFeedback'),
    accountMenu: $('accountMenu'),
    accountMenuStatus: $('accountMenuStatus'),
    btnGoogle: $('btnGoogle'),
    btnReconnect: $('btnReconnect'),
    btnChangeAccount: $('btnChangeAccount'),
    btnScan: $('btnScan'),
    scanPlaceholder: $('scanPlaceholder'),
    scannerPanel: $('scannerPanel'),
    btnCloseScanner: $('btnCloseScanner'),
    scannerFeedback: $('scannerFeedback'),
    packageForm: $('packageForm'),
    guideNumber: $('guideNumber'),
    packageWeight: $('packageWeight'),
    duplicateNotice: $('duplicateNotice'),
    duplicatePreviousWeight: $('duplicatePreviousWeight'),
    btnSave: $('btnSave'),
    btnRescan: $('btnRescan'),
    saveFeedback: $('saveFeedback'),
    btnRetryUnknown: $('btnRetryUnknown'),
    successPanel: $('successPanel'),
    successTitle: $('successTitle'),
    successMessage: $('successMessage'),
    successGuide: $('successGuide'),
    successWeight: $('successWeight'),
    successTime: $('successTime'),
    btnNext: $('btnNext')
  };

  function setFeedback(element, message, type = '') {
    element.textContent = message || '';
    element.className = 'feedback' + (type ? ' is-' + type : '');
  }

  function setConnection(status, message, detail) {
    elements.connectionBadge.className = 'connection-badge ' + status;
    elements.connectionText.textContent = message;
    if (detail) elements.connectionDetail.textContent = detail;
    if (elements.accountMenuStatus) {
      elements.accountMenuStatus.textContent = state.connected ? 'Conectado' : 'Cuenta Google';
    }
  }

  // Guarda únicamente el access token temporal de Google hasta su vencimiento.
  // No almacena contraseñas ni refresh tokens. Esto evita abrir el diálogo OAuth
  // en cada recarga; cuando el token expire, la renovación se inicia desde una
  // acción explícita del trabajador.
  function rememberAuthorization() {
    if (!state.accessToken || !state.tokenExpiresAt || state.tokenExpiresAt <= Date.now()) return;
    try {
      localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify({
        accessToken: state.accessToken,
        expiresAt: state.tokenExpiresAt,
        clientId: String(CONFIG.GOOGLE_CLIENT_ID || ''),
        spreadsheetId: String(CONFIG.SPREADSHEET_ID || ''),
        savedAt: Date.now()
      }));
      localStorage.removeItem(LEGACY_AUTH_MARKER_KEY);
    } catch (_) {
      // Si el almacenamiento está bloqueado, la sesión durará hasta cerrar o recargar.
    }
  }

  function restoreRememberedAuthorization() {
    try {
      const raw = localStorage.getItem(AUTH_SESSION_KEY);
      localStorage.removeItem(LEGACY_AUTH_MARKER_KEY);
      if (!raw) return false;

      const saved = JSON.parse(raw);
      const compatible = saved &&
        saved.clientId === String(CONFIG.GOOGLE_CLIENT_ID || '') &&
        saved.spreadsheetId === String(CONFIG.SPREADSHEET_ID || '') &&
        typeof saved.accessToken === 'string' && saved.accessToken.length > 20 &&
        Number(saved.expiresAt) > Date.now() + 60000;

      if (!compatible) {
        localStorage.removeItem(AUTH_SESSION_KEY);
        return false;
      }

      state.accessToken = saved.accessToken;
      state.tokenExpiresAt = Number(saved.expiresAt);
      return true;
    } catch (_) {
      try { localStorage.removeItem(AUTH_SESSION_KEY); } catch (ignored) { /* Storage no disponible. */ }
      return false;
    }
  }

  function forgetAuthorization() {
    try {
      localStorage.removeItem(AUTH_SESSION_KEY);
      localStorage.removeItem(LEGACY_AUTH_MARKER_KEY);
    } catch (_) { /* Storage no disponible. */ }
  }

  // Memoria local de guías registradas por este dispositivo durante el día
  // operativo de Caracas. No consulta Google Sheets ni modifica registros remotos.
  const GUIDE_MEMORY_PREFIX = 'laeScanner.scannedGuides.v1.';

  function caracasDateKey(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: CONFIG.TIME_ZONE || 'America/Caracas',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const values = {};
    parts.forEach((part) => { values[part.type] = part.value; });
    return values.year + '-' + values.month + '-' + values.day;
  }

  function guideMemoryStorageKey(dateKey) {
    return GUIDE_MEMORY_PREFIX + String(CONFIG.SPREADSHEET_ID || 'default') + '.' + dateKey;
  }

  function loadGuideMemoryForToday() {
    const dateKey = caracasDateKey();
    state.guideMemoryDateKey = dateKey;
    state.scannedGuides = new Map();

    try {
      const raw = localStorage.getItem(guideMemoryStorageKey(dateKey));
      if (raw) {
        const stored = JSON.parse(raw);
        if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
          Object.entries(stored).forEach(([guide, entry]) => {
            const normalizedGuide = String(guide || '').trim();
            const weightKg = Number(entry && entry.weightKg);
            if (normalizedGuide && Number.isFinite(weightKg) && weightKg > 0) {
              state.scannedGuides.set(normalizedGuide, {
                weightKg,
                savedAt: String(entry.savedAt || ''),
                updatedRange: String(entry.updatedRange || '')
              });
            }
          });
        }
      }

      // Elimina días anteriores de la memoria de esta aplicación.
      const scopePrefix = GUIDE_MEMORY_PREFIX + String(CONFIG.SPREADSHEET_ID || 'default') + '.';
      const currentKey = guideMemoryStorageKey(dateKey);
      for (let index = localStorage.length - 1; index >= 0; index--) {
        const key = localStorage.key(index);
        if (key && key.startsWith(scopePrefix) && key !== currentKey) {
          localStorage.removeItem(key);
        }
      }
    } catch (_) {
      // Si el almacenamiento está bloqueado, la memoria funciona durante
      // esta apertura mediante el Map en memoria.
    }
  }

  function ensureGuideMemoryIsCurrentDay() {
    const today = caracasDateKey();
    if (today !== state.guideMemoryDateKey) {
      loadGuideMemoryForToday();
      state.duplicateGuide = null;
      if (elements.duplicateNotice) elements.duplicateNotice.hidden = true;
    }
  }

  function getPreviouslyScannedGuide(guide) {
    ensureGuideMemoryIsCurrentDay();
    return state.scannedGuides.get(String(guide || '').trim()) || null;
  }

  function rememberScannedGuide(guide, weightKg, savedAt, updatedRange) {
    ensureGuideMemoryIsCurrentDay();
    const normalizedGuide = String(guide || '').trim();
    if (!normalizedGuide) return;

    state.scannedGuides.set(normalizedGuide, {
      weightKg: Number(weightKg),
      savedAt: String(savedAt || ''),
      updatedRange: String(updatedRange || '')
    });

    // Evita que una jornada excepcionalmente grande haga crecer la memoria sin límite.
    while (state.scannedGuides.size > 2500) {
      const oldestGuide = state.scannedGuides.keys().next().value;
      state.scannedGuides.delete(oldestGuide);
    }

    try {
      const snapshot = {};
      state.scannedGuides.forEach((entry, key) => { snapshot[key] = entry; });
      localStorage.setItem(guideMemoryStorageKey(state.guideMemoryDateKey), JSON.stringify(snapshot));
    } catch (_) {
      // El registro en Google ya quedó confirmado; el Map conserva la memoria
      // mientras la aplicación permanezca abierta.
    }
  }

  function renderDuplicateGuideNotice(entry) {
    const isDuplicate = Boolean(entry);
    elements.duplicateNotice.hidden = !isDuplicate;
    if (isDuplicate) {
      elements.duplicatePreviousWeight.textContent = Number(entry.weightKg).toLocaleString('es-VE', {
        minimumFractionDigits: 3,
        maximumFractionDigits: 3
      }) + ' kg';
      elements.btnSave.textContent = 'Guardar nueva versión';
    } else {
      elements.duplicatePreviousWeight.textContent = '';
      elements.btnSave.textContent = 'Enviar a Google Sheets';
    }
  }

  function isTokenValid() {
    return Boolean(state.accessToken && Date.now() < state.tokenExpiresAt - 30000);
  }

  function renderConnectionUI() {
    // Mientras se valida el token guardado, solo mostramos el estado compacto
    // 'Conectando' del encabezado. La tarjeta aparece si realmente falta acceso.
    elements.connectionCard.hidden = state.connected || state.restoringSession;
    elements.accountMenu.hidden = !state.connected;
    elements.btnGoogle.hidden = state.connected || state.restoringSession;
    elements.btnScan.disabled = !(state.connected && isTokenValid());
    if (!state.connected) elements.accountMenu.open = false;
  }

  function getToken() {
    if (isTokenValid()) return state.accessToken;

    state.accessToken = null;
    state.tokenExpiresAt = 0;
    state.connected = false;
    state.restoringSession = false;
    forgetAuthorization();
    setConnection('is-offline', 'Sesión vencida', 'Para continuar, renueva el acceso a Google.');
    renderConnectionUI();
    setFeedback(elements.connectionFeedback, 'Tu autorización anterior sigue registrada en Google. Pulsa Conectar Google para obtener un nuevo token.', 'warning');
    return null;
  }

  function hasValidConfig() {
    return Boolean(
      CONFIG.GOOGLE_CLIENT_ID &&
      !CONFIG.GOOGLE_CLIENT_ID.startsWith('PEGA_AQUI') &&
      CONFIG.SPREADSHEET_ID &&
      CONFIG.SHEET_NAME
    );
  }

  function initGoogleAuthorization() {
    if (!hasValidConfig()) {
      setConnection('is-offline', 'Falta configuración', 'Debes colocar el Client ID OAuth de Google en config.js.');
      setFeedback(elements.connectionFeedback, 'Configuración pendiente: GOOGLE_CLIENT_ID.', 'warning');
      elements.btnGoogle.textContent = 'Configurar Google';
      renderConnectionUI();
      return false;
    }

    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      setConnection('is-offline', 'Google no disponible', 'No se pudo cargar el servicio de autorización de Google. Revisa la conexión.');
      setFeedback(elements.connectionFeedback, 'No se cargó Google Identity Services. Recarga la página con Internet.', 'error');
      renderConnectionUI();
      return false;
    }

    state.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.GOOGLE_CLIENT_ID,
      scope: CONFIG.GOOGLE_SCOPE,
      // El consentimiento se solicita la primera vez. En las siguientes
      // autorizaciones se evita forzar el selector de cuentas.
      prompt: '',
      callback: handleOAuthResponse,
      error_callback: handleOAuthUxError
    });
    return true;
  }

  async function handleOAuthResponse(response) {
    state.authPending = false;
    state.restoringSession = false;
    elements.btnGoogle.disabled = false;
    elements.btnReconnect.disabled = false;
    elements.btnChangeAccount.disabled = false;

    if (!response || response.error || !response.access_token) {
      const message = describeOAuthError(response || {});
      state.accessToken = null;
      state.tokenExpiresAt = 0;
      state.connected = false;
      setConnection('is-offline', 'No conectado', 'No se pudo recuperar el acceso a Google Sheets.');
      setFeedback(elements.connectionFeedback, message, 'error');
      renderConnectionUI();
      return;
    }

    state.accessToken = response.access_token;
    state.tokenExpiresAt = Date.now() + (Number(response.expires_in) || 3600) * 1000;
    state.connected = false;
    setConnection('is-loading', 'Verificando', 'Comprobando acceso a la hoja de Google Sheets…');
    setFeedback(elements.connectionFeedback, 'Verificando los permisos de edición sobre Paquetes…');
    elements.btnGoogle.disabled = true;
    renderConnectionUI();

    try {
      await verifySheetAccess(state.accessToken);
      state.connected = true;
      rememberAuthorization();
      setConnection('is-online', 'Conectado', 'Cuenta autorizada y pestaña Paquetes disponible.');
      setFeedback(elements.connectionFeedback, 'Conexión correcta con la base de datos LAE.', 'success');
      renderConnectionUI();

      if (state.pendingSaveAfterAuth) {
        state.pendingSaveAfterAuth = false;
        // La guía y el peso permanecen en el formulario mientras se renueva
        // el token; continúa el envío pendiente automáticamente.
        await savePackage();
      }
    } catch (error) {
      state.accessToken = null;
      state.tokenExpiresAt = 0;
      state.connected = false;
      forgetAuthorization();
      setConnection('is-offline', 'Sin acceso a la hoja', 'La cuenta debe tener permiso de editor sobre la base de datos.');
      setFeedback(elements.connectionFeedback, friendlyGoogleError(error), 'error');
      renderConnectionUI();
    } finally {
      elements.btnGoogle.disabled = false;
    }
  }

  function handleOAuthUxError(error) {
    state.authPending = false;
    state.restoringSession = false;
    elements.btnGoogle.disabled = false;
    elements.btnReconnect.disabled = false;
    elements.btnChangeAccount.disabled = false;

    const reason = error && error.type ? error.type : '';
    const message = reason === 'popup_failed_to_open'
      ? 'El navegador bloqueó la ventana de Google. Permite las ventanas emergentes y vuelve a conectar.'
      : reason === 'popup_closed'
        ? 'Se cerró la ventana de Google antes de terminar la conexión.'
        : 'No se pudo completar la autorización. Inténtalo nuevamente.';

    if (!state.connected) {
      state.accessToken = null;
      state.tokenExpiresAt = 0;
      setConnection('is-offline', 'No conectado', 'Se necesita autorización para registrar paquetes.');
      renderConnectionUI();
    }
    setFeedback(elements.connectionFeedback, message, 'warning');
  }

  function describeOAuthError(response) {
    if (response.error === 'access_denied') return 'Google no concedió el permiso solicitado. Conecta la cuenta y acepta el acceso a Google Sheets.';
    if (response.error === 'interaction_required' || response.error === 'login_required') return 'Google necesita que confirmes la cuenta. Pulsa Conectar Google para continuar.';
    return response.error_description || response.error || 'Google no pudo autorizar esta solicitud.';
  }

  async function restoreStoredSession() {
    state.restoringSession = true;
    state.connected = false;
    setConnection('is-loading', 'Conectando', 'Restaurando el acceso guardado en este dispositivo…');
    setFeedback(elements.connectionFeedback, 'Verificando la sesión…');
    renderConnectionUI();

    try {
      await verifySheetAccess(state.accessToken);
      if (!isTokenValid()) throw Object.assign(new Error('El token guardado ya venció.'), { status: 401 });
      state.connected = true;
      state.restoringSession = false;
      setConnection('is-online', 'Conectado', 'Sesión recuperada sin abrir una ventana de Google.');
      setFeedback(elements.connectionFeedback, 'Conexión recuperada. Ya puedes escanear paquetes.', 'success');
      renderConnectionUI();
    } catch (error) {
      state.connected = false;
      state.restoringSession = false;
      if (error && error.status === 401) {
        state.accessToken = null;
        state.tokenExpiresAt = 0;
        forgetAuthorization();
        setConnection('is-offline', 'Sesión vencida', 'Vuelve a conectar tu cuenta Google para continuar.');
        setFeedback(elements.connectionFeedback, 'La sesión guardada venció. Pulsa Conectar Google; no tendrás que borrar la caché.', 'warning');
      } else {
        // Conserva el token en caso de una interrupción temporal de red o un
        // problema de permisos; el usuario puede reintentar o cambiar la cuenta.
        setConnection('is-offline', 'No se pudo conectar', 'Comprueba Internet y los permisos de edición de la hoja.');
        setFeedback(elements.connectionFeedback, friendlyGoogleError(error), 'error');
      }
      renderConnectionUI();
    }
  }

  async function verifySheetAccess(token) {
    const url = new URL('https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(CONFIG.SPREADSHEET_ID));
    url.searchParams.set('fields', 'sheets.properties.title');
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token }
    });
    const data = await parseGoogleResponse(response);
    if (!response.ok) throw makeGoogleError(response.status, data);

    const titles = (data.sheets || []).map((sheet) => sheet.properties && sheet.properties.title).filter(Boolean);
    if (!titles.includes(CONFIG.SHEET_NAME)) {
      throw new Error('No se encontró la pestaña "' + CONFIG.SHEET_NAME + '" en la hoja de cálculo configurada.');
    }
    return data;
  }

  async function parseGoogleResponse(response) {
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); }
    catch (_) { return { raw: text }; }
  }

  function makeGoogleError(status, data) {
    const message = data && data.error && data.error.message ? data.error.message : 'Google Sheets respondió con HTTP ' + status + '.';
    const error = new Error(message);
    error.status = status;
    error.payload = data;
    return error;
  }

  function friendlyGoogleError(error) {
    if (error && error.status === 401) return 'La autorización venció o no es válida. Pulsa Conectar Google para renovarla.';
    if (error && error.status === 403) return 'Google rechazó el permiso. Comprueba que esta cuenta tenga acceso de editor a la hoja y que Sheets API esté habilitada en el proyecto de Google Cloud.';
    if (error && error.status === 404) return 'No se encontró la hoja configurada. Comprueba el ID de Google Sheets.';
    if (error && error.message && error.message.includes('No se encontró la pestaña')) return error.message;
    if (error instanceof TypeError) return 'No se pudo establecer conexión con Google. Revisa Internet y vuelve a intentarlo.';
    return error && error.message ? error.message : 'Ocurrió un error inesperado.';
  }

  function requestGoogleAccess(options = {}) {
    const changeAccount = Boolean(options.changeAccount);
    const autoRestore = Boolean(options.autoRestore);
    if (options.resumeSave) state.pendingSaveAfterAuth = true;

    if (!hasValidConfig()) {
      setFeedback(elements.connectionFeedback, 'Primero configura GOOGLE_CLIENT_ID en config.js.', 'warning');
      return;
    }
    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      setFeedback(elements.connectionFeedback, 'Google Identity Services todavía no está disponible. Recarga la página.', 'error');
      return;
    }
    if (!state.tokenClient && !initGoogleAuthorization()) return;
    if (state.authPending) return;

    state.authPending = true;
    state.authMode = autoRestore ? 'auto' : (changeAccount ? 'change' : 'user');
    if (!autoRestore) {
      elements.btnGoogle.disabled = true;
      elements.btnReconnect.disabled = true;
      elements.btnChangeAccount.disabled = true;
    }
    if (changeAccount) {
      state.accessToken = null;
      state.tokenExpiresAt = 0;
      state.connected = false;
      state.restoringSession = false;
      forgetAuthorization();
    }

    setConnection('is-loading', autoRestore ? 'Recuperando cuenta' : 'Conectando', autoRestore
      ? 'Recuperando el acceso previamente autorizado…'
      : 'Solicitando autorización de Google…');
    if (!autoRestore) setFeedback(elements.connectionFeedback, changeAccount
      ? 'Selecciona la cuenta de Google que deseas utilizar.'
      : 'Conectando la cuenta que ya autorizaste. Solo se solicitará consentimiento si Google lo necesita.');
    renderConnectionUI();

    try {
      state.tokenClient.requestAccessToken({ prompt: changeAccount ? 'select_account' : '' });
    } catch (error) {
      state.authPending = false;
      elements.btnGoogle.disabled = false;
      setConnection('is-offline', 'No conectado', 'No se pudo iniciar la autorización.');
      setFeedback(elements.connectionFeedback, friendlyGoogleError(error), 'error');
      renderConnectionUI();
    }
  }

  function extractGuide(rawValue) {
    const raw = String(rawValue || '').trim();
    const candidates = raw.match(/\d{9,}/g) || [];
    if (candidates.length) {
      candidates.sort((a, b) => b.length - a.length);
      return candidates[0];
    }
    const digits = raw.replace(/\D/g, '');
    return digits.length >= 9 ? digits : '';
  }

  function scannerConfig() {
    return {
      fps: 12,
      qrbox: (viewfinderWidth, viewfinderHeight) => {
        const edge = Math.min(viewfinderWidth, viewfinderHeight);
        const size = Math.max(170, Math.floor(edge * 0.72));
        return { width: size, height: size };
      },
      aspectRatio: 1,
      formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      rememberLastUsedCamera: true
    };
  }

  async function openScanner() {
    if (!getToken()) {
      setFeedback(elements.connectionFeedback, 'Conecta Google para continuar escaneando.', 'warning');
      return false;
    }
    if (!window.Html5Qrcode) {
      setFeedback(elements.scannerFeedback, 'No se pudo cargar el lector QR. Comprueba la conexión a Internet y recarga.', 'error');
      return false;
    }

    elements.scanPlaceholder.hidden = true;
    elements.btnScan.hidden = true;
    elements.scannerPanel.hidden = false;
    elements.packageForm.hidden = true;
    elements.successPanel.hidden = true;
    elements.btnNext.hidden = true;
    setFeedback(elements.scannerFeedback, 'Activando cámara…');

    try {
      if (!state.scanner) state.scanner = new Html5Qrcode('qr-reader', { verbose: false });
      await state.scanner.start(
        { facingMode: 'environment' },
        scannerConfig(),
        handleQrSuccess,
        () => {}
      );
      state.scanning = true;
      setFeedback(elements.scannerFeedback, 'Cámara activa. Enfoca el siguiente código QR.');
      return true;
    } catch (error) {
      state.scanning = false;
      elements.scannerPanel.hidden = true;
      elements.scanPlaceholder.hidden = false;
      elements.btnScan.hidden = false;
      elements.btnScan.disabled = !isTokenValid();
      setFeedback(elements.scannerFeedback, cameraError(error), 'error');
      return false;
    }
  }

  function cameraError(error) {
    const message = String(error && error.message ? error.message : error || '');
    if (/permission|NotAllowedError|denied/i.test(message)) return 'No se concedió permiso para usar la cámara. Habilita la cámara para este sitio en Chrome.';
    if (/NotFoundError|no camera/i.test(message)) return 'No se encontró una cámara disponible en este teléfono.';
    if (/secure|https/i.test(message)) return 'La cámara requiere una conexión segura HTTPS. Abre la aplicación desde GitHub Pages.';
    return 'No se pudo iniciar la cámara. Revisa los permisos del navegador e inténtalo nuevamente.';
  }

  async function handleQrSuccess(decodedText) {
    if (!state.scanning) return;
    state.scanning = false;
    const guide = extractGuide(decodedText);
    await stopScanner();
    elements.scannerPanel.hidden = true;
    elements.scanPlaceholder.hidden = true;

    if (!guide) {
      elements.btnScan.hidden = false;
      elements.scanPlaceholder.hidden = true;
      setFeedback(elements.saveFeedback, 'El QR no contiene un número de guía reconocible. Se reactivará el lector…', 'error');
      window.setTimeout(() => openScanner(), 900);
      return;
    }

    state.guide = guide;
    state.duplicateGuide = getPreviouslyScannedGuide(guide);
    elements.guideNumber.value = guide;
    elements.packageWeight.value = state.duplicateGuide
      ? Number(state.duplicateGuide.weightKg).toFixed(3)
      : '';
    renderDuplicateGuideNotice(state.duplicateGuide);
    elements.packageForm.hidden = false;
    elements.successPanel.hidden = true;

    if (state.duplicateGuide) {
      setFeedback(
        elements.saveFeedback,
        'Esta guía ya se registró hoy desde este dispositivo. Puedes ajustar el peso; si confirmas el envío, se agregará una nueva versión y el sistema administrativo tomará la más reciente.',
        'warning'
      );
    } else {
      setFeedback(elements.saveFeedback, 'Guía capturada. Introduce el peso y guarda el paquete.', 'success');
    }

    window.setTimeout(() => {
      elements.packageWeight.focus({ preventScroll: true });
      if (state.duplicateGuide) elements.packageWeight.select();
    }, 120);
  }

  async function stopScanner() {
    if (!state.scanner) return;
    try {
      if (state.scanning || state.scanner.isScanning) await state.scanner.stop();
    } catch (_) {
      // La cámara pudo haberse detenido automáticamente en el navegador.
    }
    state.scanning = false;
  }

  function parseWeight(value) {
    const normalized = String(value || '').trim().replace(',', '.');
    if (!/^\d{1,5}(\.\d{1,3})?$/.test(normalized)) return null;
    const weight = Number(normalized);
    return Number.isFinite(weight) && weight > 0 ? weight : null;
  }

  function formatCaracasTime(date) {
    return new Intl.DateTimeFormat('es-VE', {
      timeZone: CONFIG.TIME_ZONE || 'America/Caracas',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
    }).format(date);
  }

  async function savePackage(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (state.saving) return;

    const token = getToken();
    if (!token) {
      // El clic en Enviar sirve como gesto del usuario para renovar el token.
      // Una vez renovado, el mismo formulario se envía automáticamente.
      setFeedback(elements.saveFeedback, 'Renovando el acceso a Google antes de guardar…', 'warning');
      requestGoogleAccess({ resumeSave: true });
      return;
    }

    const guide = String(elements.guideNumber.value || '').trim();
    const isEdit = Boolean(state.duplicateGuide);
    const weight = parseWeight(elements.packageWeight.value);
    if (!guide) {
      setFeedback(elements.saveFeedback, 'Primero debes escanear un código QR válido.', 'error');
      return;
    }
    if (weight === null) {
      setFeedback(elements.saveFeedback, 'Introduce un peso válido mayor que cero. Puedes usar coma o punto decimal.', 'error');
      elements.packageWeight.focus();
      return;
    }

    const timestamp = new Date();
    const timestampISO = timestamp.toISOString();
    const values = [[timestampISO, guide, weight]];
    const range = encodeURIComponent(CONFIG.SHEET_RANGE || (CONFIG.SHEET_NAME + '!A:C'));
    const url = 'https://sheets.googleapis.com/v4/spreadsheets/' +
      encodeURIComponent(CONFIG.SPREADSHEET_ID) + '/values/' + range +
      ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS&includeValuesInResponse=true';

    state.saving = true;
    elements.btnSave.disabled = true;
    elements.btnRescan.disabled = true;
    elements.btnSave.textContent = 'Enviando…';
    setFeedback(elements.saveFeedback, 'Enviando los datos directamente a Google Sheets…');
    let saved = false;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ majorDimension: 'ROWS', values })
      });
      const data = await parseGoogleResponse(response);
      if (!response.ok) throw makeGoogleError(response.status, data);

      const updates = data.updates || {};
      if (Number(updates.updatedRows) !== 1 || Number(updates.updatedCells) < 3 || !updates.updatedRange) {
        const uncertain = new Error('Google respondió, pero no fue posible verificar las tres celdas registradas.');
        uncertain.uncertain = true;
        throw uncertain;
      }

      // Solo se memoriza la guía después de que Sheets confirme las tres celdas.
      rememberScannedGuide(guide, weight, timestampISO, updates.updatedRange);

      elements.successTitle.textContent = isEdit ? 'Nueva versión registrada' : 'Paquete registrado';
      elements.successGuide.textContent = guide;
      elements.successWeight.textContent = weight.toLocaleString('es-VE', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + ' kg';
      elements.successTime.textContent = formatCaracasTime(timestamp);
      elements.successMessage.textContent = isEdit
        ? 'La edición quedó guardada en Google Sheets. El sistema administrativo reconocerá esta versión como la más reciente. Preparando el siguiente escaneo…'
        : 'Google Sheets confirmó el registro. Preparando el siguiente escaneo…';
      elements.packageForm.hidden = true;
      elements.successPanel.hidden = false;
      elements.btnNext.hidden = true;
      setFeedback(elements.saveFeedback, '');
      state.guide = '';
      state.duplicateGuide = null;
      saved = true;
    } catch (error) {
      if (error && error.status === 401) {
        state.accessToken = null;
        state.tokenExpiresAt = 0;
        state.connected = false;
        state.pendingSaveAfterAuth = true;
        setConnection('is-offline', 'Reconexión necesaria', 'Google requiere renovar el acceso.');
        setFeedback(elements.connectionFeedback, 'El permiso venció. Reconecta Google; el formulario se conservará y el registro continuará después.', 'warning');
        renderConnectionUI();
      }
      const outcomeIsUncertain = error instanceof TypeError || Boolean(error && error.uncertain) || Boolean(error && [429, 500, 502, 503, 504].includes(error.status));
      if (outcomeIsUncertain) {
        state.uncertainWrite = true;
        elements.btnSave.disabled = true;
        elements.btnRetryUnknown.hidden = false;
        setFeedback(elements.saveFeedback, 'No se pudo confirmar si Google recibió el registro. Revisa primero la pestaña Paquetes. No vuelvas a enviarlo sin comprobarlo para evitar duplicados.', 'warning');
      } else {
        setFeedback(elements.saveFeedback, friendlyGoogleError(error), 'error');
      }
    } finally {
      state.saving = false;
      if (!state.uncertainWrite) elements.btnSave.disabled = false;
      elements.btnRescan.disabled = false;
      elements.btnSave.textContent = state.duplicateGuide ? 'Guardar nueva versión' : 'Enviar a Google Sheets';
    }

    if (saved) {
      // Breve confirmación visual y retorno automático al lector.
      window.clearTimeout(state.autoRestartTimer);
      state.autoRestartTimer = window.setTimeout(async () => {
        elements.successPanel.hidden = true;
        elements.packageForm.reset();
        elements.guideNumber.value = '';
        elements.packageWeight.value = '';
        elements.btnScan.hidden = false;
        elements.scanPlaceholder.hidden = false;
        await openScanner();
      }, 950);
    }
  }

  function resetForNextScan() {
    if (state.uncertainWrite) {
      const confirmed = window.confirm('El envío anterior no tuvo confirmación. ¿Ya revisaste la hoja Paquetes y confirmas que esta guía no aparece?');
      if (!confirmed) return;
    }
    state.uncertainWrite = false;
    elements.btnRetryUnknown.hidden = true;
    elements.btnSave.disabled = false;
    elements.packageForm.reset();
    elements.guideNumber.value = '';
    elements.packageWeight.value = '';
    state.guide = '';
    state.duplicateGuide = null;
    renderDuplicateGuideNotice(null);
    elements.packageForm.hidden = true;
    elements.successPanel.hidden = true;
    elements.scanPlaceholder.hidden = false;
    elements.btnScan.hidden = false;
    elements.btnScan.disabled = !isTokenValid();
    setFeedback(elements.saveFeedback, '');
    if (!elements.btnScan.disabled) openScanner();
  }

  async function closeScanner() {
    window.clearTimeout(state.autoRestartTimer);
    await stopScanner();
    elements.scannerPanel.hidden = true;
    elements.scanPlaceholder.hidden = false;
    elements.btnScan.hidden = false;
    if (!isTokenValid()) elements.btnScan.disabled = true;
  }

  function bindEvents() {
    elements.btnGoogle.addEventListener('click', () => requestGoogleAccess());
    elements.btnReconnect.addEventListener('click', () => {
      elements.accountMenu.open = false;
      requestGoogleAccess();
    });
    elements.btnChangeAccount.addEventListener('click', () => {
      elements.accountMenu.open = false;
      requestGoogleAccess({ changeAccount: true });
    });
    elements.btnScan.addEventListener('click', openScanner);
    elements.btnCloseScanner.addEventListener('click', closeScanner);
    elements.packageForm.addEventListener('submit', savePackage);
    elements.btnRescan.addEventListener('click', resetForNextScan);
    elements.btnNext.addEventListener('click', resetForNextScan);
    elements.btnRetryUnknown.addEventListener('click', () => {
      state.uncertainWrite = false;
      elements.btnRetryUnknown.hidden = true;
      elements.btnSave.disabled = false;
      setFeedback(elements.saveFeedback, 'Reintento habilitado. Solo continúa si verificaste que la guía no quedó registrada.', 'warning');
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state.scanning) stopScanner();
    });
    window.addEventListener('pagehide', () => { stopScanner(); });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;

    let refreshingForUpdate = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // Cuando una versión nueva toma el control, recarga una sola vez para
      // mostrar todos sus archivos juntos. Nunca solicita borrar datos del sitio.
      if (refreshingForUpdate) return;
      refreshingForUpdate = true;
      window.location.reload();
    });

    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .then((registration) => {
        // Comprueba si GitHub Pages ya publicó una versión nueva.
        registration.update().catch(() => {
          // Si no hay red, la versión en caché sigue disponible.
        });
      })
      .catch(() => {
        // La aplicación sigue funcionando aunque el service worker no se registre.
      });
  }

  function init() {
    bindEvents();
    loadGuideMemoryForToday();
    renderDuplicateGuideNotice(null);
    if (initGoogleAuthorization()) {
      if (restoreRememberedAuthorization()) {
        // Reutiliza el access token local mientras siga vigente y comprueba
        // directamente el acceso a Sheets. No abre el popup OAuth al recargar.
        restoreStoredSession();
      } else {
        state.connected = false;
        state.restoringSession = false;
        setConnection('is-offline', 'Sin conectar', 'Conecta una cuenta Google con permiso de edición para comenzar.');
        setFeedback(elements.connectionFeedback, 'Conecta Google una sola vez en este dispositivo. La sesión temporal se conservará para las siguientes recargas.');
        renderConnectionUI();
      }
    }
    registerServiceWorker();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
