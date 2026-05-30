<div align="center">

# 📬 NoniMail

### Limpiá tu bandeja de entrada con inteligencia artificial — local y privada

*Conectá Gmail, Outlook o cualquier IMAP, escaneá todo tu buzón, y dejá que un modelo de IA agrupe y clasifique tus correos por remitente. Vos decidís qué se queda y qué se va — a la Papelera, siempre recuperable.*

**Autor: Danilo Estuardo Gonzalez Rizzo**

`Node.js` · `IA local (Ollama)` · `Gmail / Outlook / IMAP` · `Multi-usuario`

</div>

---

## ¿Qué hace? (en simple)

Tu correo está lleno de promociones, newsletters y notificaciones que nunca leés. NoniMail:

1. **Se conecta** a tu buzón (Gmail, Outlook o IMAP — el que uses).
2. **Lee y agrupa** todos tus correos por remitente.
3. **Le pregunta a una IA** (que corre en *tu* computadora, sin mandar tus correos a ningún lado) qué tan "ruido" es cada remitente, del 0 al 100.
4. **Vos elegís** con un deslizador qué tan agresivo querés ser, y revisás la lista.
5. **Borra a la Papelera** lo que marcaste — recuperable 30 días, nunca se elimina para siempre.

Lo importante: **es privado** (la IA es local) y **es seguro** (nunca borra de forma permanente, y protege automáticamente correos importantes como bancos, facturas y conversaciones donde vos respondiste).

---

## ✨ Características

- 🔌 **3 conectores**: Gmail (API oficial), Outlook/Microsoft 365 (Graph) e IMAP genérico (Carbonio, Dovecot, etc.)
- 🧠 **Clasificación con IA local** — Ollama en tu máquina; tus correos nunca salen de ahí
- 🛡️ **Protecciones automáticas**: bancos, facturas, recibos, códigos 2FA, alertas de seguridad, conversaciones reales y los dominios que vos configures — **nunca se borran**
- 🎚️ **Deslizador de dureza** — de conservador a agresivo, recalcula en vivo sin volver a escanear
- 👤🌐 **Reglas por remitente y por dominio** — "conservar siempre" / "borrar siempre", guardadas
- 🔄 **Vista por remitente o por dominio** con un switch
- 📊 **En vivo**: barra de progreso, terminales de CPU/GPU y los puntajes apareciendo mientras escanea
- 🗑️ **Borrado a Papelera** (recuperable), nunca permanente
- 👥 **Multi-usuario** con login propio (JWT) y credenciales cifradas (AES-256-GCM)

---

## 🚀 Cómo levantarlo

> Requiere **Node.js ≥ 22** (usa el SQLite integrado, sin compilar nada) y **[Ollama](https://ollama.com)** corriendo localmente.

```bash
# 1. Clonar
git clone https://github.com/nonoskygt/nonimail-saas.git
cd nonimail-saas

# 2. Instalar dependencias
npm install

# 3. Configurar (copiar la plantilla y rellenar)
cp .env.example .env

# 4. Modelo de IA (una vez)
ollama pull qwen3:8b

# 5. Arrancar
npm start
```

Abrí **http://localhost:8780**, registrate, conectá un buzón y dale a **Escanear**.

### Variables mínimas en `.env`

```ini
JWT_SECRET=<algo largo y aleatorio>
ENCRYPTION_KEY=<64 caracteres hex>     # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
PROTECT_DOMAINS=midominio.com,mibanco.com   # dominios que nunca se borran
```

**IMAP funciona sin configuración extra.** Para Gmail/Outlook necesitás credenciales OAuth (ver abajo).

---

## 🔑 Conectar Gmail / Outlook (OAuth)

<details>
<summary><b>Gmail</b> (Google Cloud)</summary>

1. [console.cloud.google.com](https://console.cloud.google.com) → nuevo proyecto → habilitar **Gmail API**
2. *Credenciales* → *Crear credenciales* → *ID de cliente OAuth* → **Aplicación web**
3. URI de redireccionamiento: `http://localhost:8780/api/connect/gmail/callback`
4. En *Acceso a los datos*, agregá el permiso `gmail.modify`
5. Copiá Client ID y Secret a tu `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`)

</details>

<details>
<summary><b>Outlook / Microsoft 365</b> (Entra ID)</summary>

1. [entra.microsoft.com](https://entra.microsoft.com) → *App registrations* → nueva
2. URI de redireccionamiento (Web): `http://localhost:8780/api/connect/outlook/callback`
3. Permisos de Microsoft Graph (delegados): `Mail.ReadWrite`, `Mail.Send`, `User.Read`, `offline_access`
4. Creá un client secret y copialo a `.env` (`MS_CLIENT_ID`, `MS_CLIENT_SECRET`)

</details>

---

## 🧱 Cómo está hecho

```
src/
  server.js          Servidor HTTP (Express)
  config.js          Configuración (lee .env)
  crypto.js          Cifrado de tokens en reposo (AES-256-GCM)
  db.js              Datos: usuarios, buzones, reglas (SQLite nativo de Node)
  auth/              Login propio (JWT + bcrypt)
  llm/               Cliente de la IA (Ollama) — puntaje 0-100 de "ruido"
  providers/         ★ Abstracción común + conectores
    base.js            Interfaz MailProvider (el contrato)
    gmail.js           Gmail (OAuth + batch trash)
    outlook.js         Outlook / Microsoft Graph
    imap.js            IMAP genérico (pool de conexiones)
  mail/
    engine.js          Motor de clasificación (heurística + IA + protecciones)
    scan.js            Escaneo por remitente, ejecución de borrado, baja
    live.js            Eventos en vivo + métricas
public/index.html    La interfaz completa
```

**La idea clave:** el motor habla con una sola interfaz (`MailProvider`), nunca con Gmail/Outlook/IMAP directamente. Por eso agregar un proveedor nuevo es solo escribir un archivo más.

---

## 🔒 Privacidad y seguridad

- **Tus correos nunca salen de tu máquina** — la clasificación la hace una IA local.
- **Nada se borra permanentemente** — todo va a la Papelera, recuperable.
- **Credenciales cifradas** en reposo (AES-256-GCM); los secretos viven solo en tu `.env` (que no se sube al repo).
- **Sesgo a conservar**: ante la duda, NoniMail prefiere dejar el correo.

---

<div align="center">
<sub>Hecho por <b>Danilo Estuardo Gonzalez Rizzo</b> · Familia Nonosky</sub>
</div>
