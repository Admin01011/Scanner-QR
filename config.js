/*
 * CONFIGURACIÓN DE LAE SCANNER
 * El ID de Google Sheets ya corresponde a la base actual de LAE Catia.
 * Solo debes sustituir GOOGLE_CLIENT_ID por el ID de cliente OAuth web.
 * No coloques aquí client_secret ni tokens.
 */
window.LAE_CONFIG = Object.freeze({
  APP_NAME: 'LAE Scanner',
  GOOGLE_CLIENT_ID: 'PEGA_AQUI_TU_CLIENT_ID.apps.googleusercontent.com',
  SPREADSHEET_ID: '1Pg5E9QyXUTX3uVV9vT5WCv_ZEIDMVefu0OWOAxXls_I',
  SHEET_NAME: 'Paquetes',
  SHEET_RANGE: 'Paquetes!A:C',
  GOOGLE_SCOPE: 'https://www.googleapis.com/auth/spreadsheets',
  TIME_ZONE: 'America/Caracas'
});
