(() => {
  'use strict';

  const CONFIG = window.LAE_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const state = {
    accessToken: null,
    tokenExpiresAt: 0,
    tokenClient: null,
    scanner: null,
    scanning: false,
    saving: false,
    uncertainWrite: false,
    guide: '',
    lastTimestamp: null
  };

  const elements = {
    connectionBadge: $('connectionBadge'),
    connectionText: $('connectionText'),
    connectionDetail: $('connectionDetail'),
    connectionFeedback: $('connectionFeedback'),
    btnGoogle: $('btnGoogle'),
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
  }

  function hasValidConfig() {
    return Boolean(
      CONFIG.GOOGLE_CLIENT_ID &&
      !CONFIG.GOOGLE_CLIENT_ID.startsWith('PEGA_AQUI') &&
      CONFIG.SPREADSHEET_ID &&
      CONFIG.SHEET_NAME
    );
  }

  function getToken() {
    if (!state.accessToken || Date.now() >= state.tokenExpiresAt - 30000) {
      state.accessToken = null;
      state.tokenExpiresAt = 0;
      setConnection('is-offline', 'Sesión vencida', 'Vuelve a conectar Google para continuar registrando paquetes.');
      elements.btnScan.disabled = true;
      return null;
    }
    return state.accessToken;
  }

  function initGoogleAuthorization() {
    if (!hasValidConfig()) {
      setConnection('is-offline', 'Falta configuración', 'Debes colocar el Client ID OAuth de Google en config.js.');
      setFeedback(elements.connectionFeedback, 'Configuración pendiente: GOOGLE_CLIENT_ID.', 'warning');
      elements.btnGoogle.textContent = 'Configurar Google';
      elements.btnScan.disabled = true;
      return;
    }

    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      setConnection('is-offline', 'Google no disponible', 'No se pudo cargar el servicio de autorización de Google. Revisa la conexión.');
      setFeedback(elements.connectionFeedback, 'No se cargó Google Identity Services. Recarga la página con Internet.', 'error');
      return;
    }

    state.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.GOOGLE_CLIENT_ID,
      scope: CONFIG.GOOGLE_SCOPE,
      callback: async (response) => {
        if (response.error) {
          elements.btnGoogle.disabled = false;
          state.accessToken = null;
          setConnection('is-offline', 'No conectado', 'No se pudo autorizar la cuenta de Google.');
          setFeedback(elements.connectionFeedback, describeOAuthError(response), 'error');
          elements.btnScan.disabled = true;
          return;
        }

        state.accessToken = response.access_token;
        state.tokenExpiresAt = Date.now() + (Number(response.expires_in) || 3600) * 1000;
        setConnection('is-loading', 'Verificando', 'Comprobando acceso a la hoja de Google Sheets…');
        elements.btnGoogle.disabled = true;
        setFeedback(elements.connectionFeedback, 'Verificando permisos sobre la pestaña Paquetes…');

        try {
          const sheet = await verifySheetAccess(state.accessToken);
          setConnection('is-online', 'Conectado', 'Cuenta autorizada y pestaña Paquetes disponible.');
          setFeedback(elements.connectionFeedback, 'Conexión correcta con la base de datos LAE.', 'success');
          elements.btnGoogle.textContent = 'Cambiar cuenta';
          elements.btnScan.disabled = false;
          elements.btnScan.focus({ preventScroll: true });
          return sheet;
        } catch (error) {
          state.accessToken = null;
          state.tokenExpiresAt = 0;
          setConnection('is-offline', 'Sin acceso a la hoja', 'La cuenta debe tener permiso de editor sobre la base de datos.');
          setFeedback(elements.connectionFeedback, friendlyGoogleError(error), 'error');
          elements.btnScan.disabled = true;
        } finally {
          elements.btnGoogle.disabled = false;
        }
      },
      error_callback: (error) => {
        elements.btnGoogle.disabled = false;
        setConnection('is-offline', 'Autorización cancelada', 'No se completó la conexión con Google.');
        setFeedback(elements.connectionFeedback, error && error.message ? error.message : 'No se completó la autorización.', 'warning');
      }
    });
  }

  function describeOAuthError(response) {
    if (response.error === 'access_denied') return 'Se rechazó el permiso solicitado. Autoriza el acceso a Google Sheets para continuar.';
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
    if (error && error.status === 401) return 'La autorización venció o no es válida. Vuelve a conectar Google.';
    if (error && error.status === 403) return 'Google rechazó el permiso. Comprueba que esta cuenta tenga acceso de editor a la hoja y que Sheets API esté habilitada en el proyecto de Google Cloud.';
    if (error && error.status === 404) return 'No se encontró la hoja configurada. Comprueba el ID de Google Sheets.';
    if (error && error.message && error.message.includes('No se encontró la pestaña')) return error.message;
    if (error instanceof TypeError) return 'No se pudo establecer conexión con Google. Revisa Internet y vuelve a intentarlo.';
    return error && error.message ? error.message : 'Ocurrió un error inesperado.';
  }

  function requestGoogleAccess() {
    if (!hasValidConfig()) {
      setFeedback(elements.connectionFeedback, 'Primero configura GOOGLE_CLIENT_ID en config.js.', 'warning');
      return;
    }
    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      setFeedback(elements.connectionFeedback, 'Google Identity Services todavía no está disponible. Recarga la página.', 'error');
      return;
    }
    if (!state.tokenClient) initGoogleAuthorization();
    if (!state.tokenClient) return;

    elements.btnGoogle.disabled = true;
    setConnection('is-loading', 'Conectando', 'Esperando autorización de Google…');
    setFeedback(elements.connectionFeedback, 'Selecciona la cuenta de Google que tiene permiso de edición sobre la hoja.');
    try {
      state.tokenClient.requestAccessToken({ prompt: 'select_account' });
    } catch (error) {
      elements.btnGoogle.disabled = false;
      setConnection('is-offline', 'No conectado', 'No se pudo iniciar la autorización.');
      setFeedback(elements.connectionFeedback, friendlyGoogleError(error), 'error');
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
      setFeedback(elements.connectionFeedback, 'Conecta Google antes de escanear.', 'warning');
      return;
    }
    if (!window.Html5Qrcode) {
      setFeedback(elements.scannerFeedback, 'No se pudo cargar el lector QR. Comprueba la conexión a Internet y recarga.', 'error');
      return;
    }

    elements.scanPlaceholder.hidden = true;
    elements.btnScan.hidden = true;
    elements.scannerPanel.hidden = false;
    elements.packageForm.hidden = true;
    elements.successPanel.hidden = true;
    setFeedback(elements.scannerFeedback, 'Solicitando acceso a la cámara…');

    try {
      if (!state.scanner) state.scanner = new Html5Qrcode('qr-reader', { verbose: false });
      await state.scanner.start(
        { facingMode: 'environment' },
        scannerConfig(),
        handleQrSuccess,
        () => {}
      );
      state.scanning = true;
      setFeedback(elements.scannerFeedback, 'Cámara activa. Enfoca el código QR dentro del recuadro.');
    } catch (error) {
      state.scanning = false;
      elements.scannerPanel.hidden = true;
      elements.scanPlaceholder.hidden = false;
      elements.btnScan.hidden = false;
      setFeedback(elements.saveFeedback, cameraError(error), 'error');
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
      elements.scanPlaceholder.hidden = false;
      setFeedback(elements.saveFeedback, 'El QR no contiene un número de guía reconocible. Intenta escanear nuevamente.', 'error');
      return;
    }

    state.guide = guide;
    elements.guideNumber.value = guide;
    elements.packageWeight.value = '';
    elements.packageForm.hidden = false;
    elements.successPanel.hidden = true;
    setFeedback(elements.saveFeedback, 'Guía capturada. Introduce el peso para completar el registro.', 'success');
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
    event.preventDefault();
    if (state.saving) return;
    const token = getToken();
    if (!token) {
      setFeedback(elements.saveFeedback, 'La sesión de Google venció. Conecta la cuenta nuevamente.', 'error');
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

      state.lastTimestamp = timestamp;
      elements.successGuide.textContent = guide;
      elements.successWeight.textContent = weight.toLocaleString('es-VE', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + ' kg';
      elements.successTime.textContent = formatCaracasTime(timestamp);
      elements.packageForm.hidden = true;
      elements.successPanel.hidden = false;
      setFeedback(elements.saveFeedback, '');
    } catch (error) {
      if (error && error.status === 401) {
        state.accessToken = null;
        state.tokenExpiresAt = 0;
        elements.btnScan.disabled = true;
        setConnection('is-offline', 'Sesión vencida', 'Conecta Google nuevamente para continuar.');
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
    elements.btnScan.disabled = !getToken();
    setFeedback(elements.saveFeedback, '');
    if (!elements.btnScan.disabled) openScanner();
  }

  async function closeScanner() {
    await stopScanner();
    elements.scannerPanel.hidden = true;
    elements.scanPlaceholder.hidden = false;
    elements.btnScan.hidden = false;
    if (!getToken()) elements.btnScan.disabled = true;
  }

  function bindEvents() {
    elements.btnGoogle.addEventListener('click', requestGoogleAccess);
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
    if (hasValidConfig()) initGoogleAuthorization();
    else {
      setConnection('is-offline', 'Falta configuración', 'Debes colocar el Client ID OAuth de Google en config.js.');
      setFeedback(elements.connectionFeedback, 'Antes de usar la app, configura GOOGLE_CLIENT_ID en config.js.', 'warning');
      elements.btnGoogle.textContent = 'Configurar Google';
    }
    registerServiceWorker();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
