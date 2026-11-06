# LAE Scanner — primera versión PWA

Aplicación web progresiva para Android que escanea QR, permite introducir el peso y escribe directamente en la pestaña `Paquetes` de la hoja actual de LAE mediante Google Sheets API.

## Qué hace esta versión

- Solicita autorización Google al trabajador.
- Verifica que la hoja de cálculo y la pestaña `Paquetes` sean accesibles.
- Abre la cámara trasera y lee códigos QR.
- Extrae la secuencia numérica de la guía (9 o más dígitos), igual que el criterio general del backend actual.
- Solicita el peso en kg.
- Agrega una fila a `Paquetes!A:C` en este orden: fecha ISO UTC, número de guía, peso numérico.
- Solo muestra el éxito después de recibir y validar la respuesta de Google Sheets (`updatedRows`, `updatedCells`, `updatedRange`).

No modifica ni consulta el proyecto Apps Script administrativo. No clasifica SALIDA/ENTRADA ni modifica lotes.

## 1. Configurar Google Cloud

1. Entra a https://console.cloud.google.com/ y crea o selecciona un proyecto.
2. Habilita **Google Sheets API** en APIs y servicios → Biblioteca.
3. Configura la pantalla de consentimiento OAuth. Para la primera prueba, utiliza audiencia **Externa** y estado **Pruebas**.
4. Agrega como usuarios de prueba las cuentas Google que usarán LAE Scanner. Cada cuenta debe tener permiso **Editor** en la hoja de LAE.
5. Crea un ID de cliente OAuth: APIs y servicios → Credenciales → Crear credenciales → ID de cliente OAuth → Aplicación web.
6. En **Orígenes autorizados de JavaScript**, agrega el origen de GitHub Pages. Ejemplo: `https://TU-USUARIO.github.io`.
   - No agregues la ruta `/repositorio/` al origen.
   - Si utilizas dominio personalizado, agrega ese dominio con `https://`.
   - No se necesita secreto de cliente ni URI de redirección para este modelo de autorización.
7. Copia el ID que termina en `apps.googleusercontent.com`.

## 2. Configurar la aplicación

Abre `config.js` y sustituye:

```js
GOOGLE_CLIENT_ID: 'PEGA_AQUI_TU_CLIENT_ID.apps.googleusercontent.com',
```

por el ID de cliente real. El ID de cliente es público; **no coloques un client_secret ni tokens** en GitHub.

El ID de Google Sheets ya está configurado para la base utilizada por LAE Control de Paquetes. La pestaña y el rango también están definidos como `Paquetes` y `Paquetes!A:C`.

## 3. Publicar en GitHub Pages

Puedes colocar los archivos en la raíz del sitio o en una carpeta, por ejemplo `scanner/`, dentro del repositorio que ya publica GitHub Pages.

Conserva esta estructura:

```text
LAE-Scanner/
├── index.html
├── styles.css
├── config.js
├── app.js
├── manifest.webmanifest
├── sw.js
├── LEEME.md
└── assets/
    ├── icon-192.png
    └── icon-512.png
```

Activa GitHub Pages como ya está configurado en tu repositorio. Debes abrirlo con HTTPS para permitir el uso de cámara y la instalación PWA.

## 4. Primera prueba en Android

1. Abre la URL HTTPS de LAE Scanner en Chrome.
2. Pulsa **Conectar Google**.
3. Selecciona una cuenta que tenga permiso Editor sobre la hoja y acepta el acceso solicitado.
4. Espera el mensaje **Conexión correcta con la base de datos LAE**.
5. Pulsa **Abrir escáner** y concede el permiso de cámara.
6. Escanea un QR de prueba, introduce el peso y pulsa **Enviar a Google Sheets**.
7. Verifica la nueva fila en `Paquetes`. La app solo muestra éxito si Google confirma que agregó una fila y tres celdas.
8. En Chrome, usa el menú → **Instalar aplicación** o **Añadir a pantalla de inicio**.

## 5. Consideraciones importantes

- Esta versión usa Google Identity Services en el modelo de token para aplicaciones que llaman APIs desde el navegador. El token vive solo en memoria; al recargar la PWA se debe volver a conectar. Google documenta que los tokens tienen vida limitada y deben solicitarse de nuevo cuando expiran.
- El alcance OAuth `spreadsheets` permite acceso amplio a las hojas que la cuenta puede editar. Por eso esta primera prueba debe mantenerse con cuentas internas de confianza y usuarios de prueba autorizados. Si se amplía a terceros, hay que revisar la estrategia de autorización y verificación OAuth.
- No se guarda contraseña ni token en `localStorage` o `sessionStorage`.
- El escáner necesita conexión a Internet para cargar Google Identity Services y la biblioteca QR, además de enviar los datos.
- La fecha se envía como ISO UTC. El Apps Script existente interpreta las fechas con zona explícita y las presenta según `America/Caracas`.
- Si la conexión se interrumpe durante el envío, puede no ser posible saber si Google recibió la escritura. La app advierte que se verifique la hoja antes de volver a enviar para evitar duplicados.
- La API agrega filas; no modifica filas anteriores ni comprueba duplicados por su cuenta. El backend administrativo actual conserva su regla de seleccionar la versión más reciente de cada guía.

## Archivos

- `index.html`: interfaz.
- `styles.css`: diseño responsive.
- `config.js`: Client ID y ubicación de la hoja.
- `app.js`: autorización, lector QR y escritura directa en Sheets.
- `manifest.webmanifest` y `sw.js`: instalación y caché del shell PWA.
