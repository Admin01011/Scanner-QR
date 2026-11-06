(() => {
  'use strict';

  const CONFIG = window.LAE_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const AUTH_MARKER_KEY = 'laeScanner.googleAuthorizationRemembered.v1';

  const state = {
    accessToken: null,
    tokenExpiresAt: 0,
    tokenClient: null,
    scanner: null,
    scanning: false,
    saving: false,
    uncertainWrite: false,
    guide: '',
    authPending: false,
    authMode: 'user',
    pendingSaveAfterAuth: false,
    connected: false,
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
    btnSave: $('btnSave'),
    btnRescan: $('btnRescan'),
    saveFeedback: $('saveFeedback'),
    btnRetryUnknown: $('btnRetryUnknown'),
    successPanel: $('successPanel'),
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

  function rememberAuthorization() {
    try { localStorage.setItem(AUTH_MARKER_KEY, '1'); } catch (_) { /* Storage no disponible. */ }
  }

  function hasRememberedAuthorization() {
    try { return localStorage.getItem(AUTH_MARKER_KEY) === '1'; }
    catch (_) { return false; }
  }

  function forgetAuthorization() {
    try { localStorage.removeItem(AUTH_MARKER_KEY); } catch (_) { /* Storage no disponible. */ }
  }

  function isTokenValid() {
    return Boolean(state.accessToken && Date.now() < state.tokenExpiresAt - 30000);
  }

  function renderConnectionUI() {
    elements.connectionCard.hidden = state.connected;
    elements.accountMenu.hidden = !state.connected;
    elements.btnScan.disabled = !isTokenValid();
    if (!state.connected) {
      elements.accountMenu.open = false;
      if (!state.authPending || state.authMode !== 'auto') elements.btnGoogle.hidden = false;
    }
  }

  function getToken() {
    if (isTokenValid()) return state.accessToken;

    state.accessToken = null;
    state.tokenExpiresAt = 0;
    state.connected = false;
    setConnection('is-offline', 'Reconexión necesaria', 'La autorización debe renovarse para continuar registrando paquetes.');
    renderConnectionUI();
    setFeedback(elements.connectionFeedback, 'Tu cuenta sigue recordada. Pulsa Conectar Google para renovar el acceso; no debería pedirte elegir la cuenta ni repetir el consentimiento.', 'warning');
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
    elements.guideNumber.value = guide;
    elements.packageWeight.value = '';
    elements.packageForm.hidden = false;
    elements.successPanel.hidden = true;
    setFeedback(elements.saveFeedback, 'Guía capturada. Introduce el peso y guarda el paquete.', 'success');
    window.setTimeout(() => elements.packageWeight.focus({ preventScroll: true }), 120);
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

      elements.successGuide.textContent = guide;
      elements.successWeight.textContent = weight.toLocaleString('es-VE', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + ' kg';
      elements.successTime.textContent = formatCaracasTime(timestamp);
      elements.successMessage.textContent = 'Registro confirmado. Preparando el siguiente escaneo…';
      elements.packageForm.hidden = true;
      elements.successPanel.hidden = false;
      elements.btnNext.hidden = true;
      setFeedback(elements.saveFeedback, '');
      state.guide = '';
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
      elements.btnSave.textContent = 'Enviar a Google Sheets';
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
    if ('serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('./sw.js').catch(() => {
        // La aplicación sigue funcionando aunque el service worker no se registre.
      });
    }
  }

  function init() {
    bindEvents();
    if (initGoogleAuthorization()) {
      if (hasRememberedAuthorization()) {
        setConnection('is-loading', 'Recuperando cuenta', 'Comprobando la autorización que ya concediste…');
        setFeedback(elements.connectionFeedback, 'Restableciendo tu conexión con Google sin volver a pedirte que elijas una cuenta…');
        renderConnectionUI();
        elements.btnGoogle.hidden = true;
        // GIS conserva el consentimiento. Se solicita un token nuevo al abrir,
        // sin forzar el selector de cuentas ni volver a mostrar consentimiento.
        requestGoogleAccess({ autoRestore: true });
      } else {
        state.connected = false;
        setConnection('is-offline', 'Sin conectar', 'Conecta una cuenta Google con permiso de edición para comenzar.');
        setFeedback(elements.connectionFeedback, 'Conecta una cuenta Google para habilitar el escáner.');
        renderConnectionUI();
      }
    }
    registerServiceWorker();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
