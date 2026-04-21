# 📋 CONTEXTO PROYECTO – FICHAJES SIMECAL

---

## 🤖 PROMPT PARA CLAUDE CODE

> Copia y pega esto al iniciar cualquier sesión con Claude Code:

```
Eres un asistente experto en el proyecto fichajes-app de SIMECAL.
Lee el archivo CONTEXTO_PROYECTO.md que está en la raíz del proyecto
y úsalo como referencia absoluta para todas las tareas.

Reglas:
- Antes de hacer cualquier cambio, revisa el contexto del proyecto.
- No modifiques la firma corporativa ni los datos de contacto de Carolina.
- Respeta la estructura de archivos existente.
- Si algo no está claro, pregunta antes de actuar.
- El servidor principal es server.js. No crear archivos nuevos sin avisar.
- La base de datos es MongoDB Atlas, colección "simecal".
- El email corporativo es cgs@simecal.com (Outlook SMTP).
```

---

> Este archivo es para que Claude Code entienda el proyecto desde el primer momento.
> Léelo siempre antes de hacer cualquier cambio.

---

## 🏢 Empresa

**SIMECAL** – Empresa de inspecciones técnicas con cobertura nacional.  
**Responsable del proyecto:** Carolina González Serrano (`cgs@simecal.com`)

---

## 🗂️ Descripción del Proyecto

Aplicación web Node.js para gestión de **fichajes de empleados**.  
Permite subir un Excel de fichajes, parsearlo, visualizarlo y enviar correos de notificación a los empleados.

---

## 🛠️ Stack Tecnológico

| Capa | Tecnología |
|------|-----------|
| Backend | Node.js + Express |
| Base de datos | MongoDB Atlas (`simecal` DB, cluster `CGS-Free`) |
| Email | Nodemailer + SMTP Outlook (`smtp-mail.outlook.com:587`) |
| Excel | Librería `xlsx` (SheetJS) |
| Upload | Multer (memoria, límite 50MB) |
| Frontend | HTML estático en `/public` |
| Deploy | Render (usa reverse proxy, `trust proxy: 1`) |

---

## 📁 Estructura de Archivos

```
fichajes-app/
├── server.js          # Servidor principal (Express)
├── package.json       # Dependencias y scripts
├── .env               # Variables de entorno (no subir a git)
├── .gitignore
└── public/
    └── index.html     # Frontend
```

---

## ⚙️ Variables de Entorno (`.env`)

```
PORT=3000
MONGODB_URI=mongodb+srv://simecal:...@cgs-free.qu2mzke.mongodb.net/simecal
SMTP_HOST=smtp-mail.outlook.com
SMTP_PORT=587
SMTP_USER=cgs@simecal.com
SMTP_PASS=<contraseña>
```

---

## 🔌 API Endpoints

### Excel / Fichajes
| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/parse-fichajes` | Sube y parsea Excel de fichajes (multipart `file`) |

### Email
| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/smtp-config` | Obtiene config SMTP (sin contraseña) |
| `POST` | `/smtp-config` | Guarda config SMTP (y persiste en `.env`) |
| `GET` | `/test-smtp` | Prueba conexión SMTP |
| `POST` | `/send-email` | Envía un correo individual |
| `POST` | `/send-all-emails` | Envío masivo (array `emails`) |

### MongoDB
| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/directorio` | Obtiene directorio de empleados |
| `POST` | `/api/directorio` | Guarda directorio de empleados |
| `POST` | `/api/historial-envio` | Registra un envío en historial |
| `GET` | `/api/historial-envio` | Obtiene últimos 200 envíos |
| `GET` | `/api/db-status` | Estado de conexión MongoDB |

---

## 📊 Lógica de Parseo del Excel (`/parse-fichajes`)

El Excel de fichajes tiene **al menos 2 hojas**:

1. **Resumen Diario** (buscada por `/diario/i` o `/resumen/i`)
   - Filas separadoras de día: contienen `📅` o patrón `DD DE MES DE YYYY`
   - Filas de datos: `[Empleado, Fecha, Entrada, Salida, Horas, Previsto, Incidencia]`
   - Output: objeto `days` → `{ "dd/mm/yyyy": [ { emp, fecha, entrada, salida, horas, previsto, incidencia } ] }`

2. **Resumen por Empleado** (buscada por `/empleado/i` o `/semanal/i`)
   - Filas de datos: `[Empleado, DíasTrabajados, TotalHoras, MediaHoras, Incidencias, EnCentro]`
   - Output: objeto `weeklyData` → `{ "semana": [ { emp, diasTrabajados, totalHoras, mediaHoras, incidencias, enCentro } ] }`

---

## 📧 Firma Corporativa (todos los correos)

```
Carolina González Serrano
Delegado Comercial – SIMECAL
📧 cgs@simecal.com | 📞 604 56 16 20 | 📲 WhatsApp: 673 42 68 34
Cobertura Nacional – Oficinas e Inspectores en todo el territorio
<< Detectamos riesgos para evitar accidentes >>
```

---

## 🔒 Seguridad

- **Rate limiting** implementado manualmente (sin dependencias extra):
  - `/send-email`: máx 20 por minuto por IP
  - `/send-all-emails`: máx 5 cada 5 minutos por IP
- TLS con `rejectUnauthorized: false` (compatibilidad Outlook)
- `.env` en `.gitignore`

---

## 🗃️ MongoDB – Colecciones

| Colección | Uso |
|-----------|-----|
| `config` | Documento `{ _id: 'directorio', empleados: {} }` – directorio de empleados |
| `historial_envios` | Registro de cada correo enviado `{ tipo, destinatario, asunto, fecha, ok }` |

---

## 📂 Excel de Pedidos (`LINEAS_PEDIDOS__2_.xlsx`)

Archivo auxiliar de gestión comercial con **62 columnas activas** en la primera fila:

`Fecha Contratación`, `Número SAP`, `Código`, `Pedido Activo`, `Empl. Contratación`, `Usu. Ejecución`, `TPC Lin.`, `TPC Ped.`, `Planif Lin.`, `Planif. Pedido`, `TPI Lin.`, `TPI Ped.`, `Línea`, `Es de 2as`, `Tiene de 2as`, `Estado Pedido`, `Estado Línea`, `Doc. Recibida`, `F.Ejec. Línea`, `F.Ejec. Pedido`, `Código Cliente`, `Cliente`, `Servicio`, `Tot. Contratado`, `Tot. Cobrado`, `Tipo Línea`, `Fechas Revisadas`, `Responsable Renovación`, `TPCE`, `TPIE`, `Fin de Semana prev.`, `H. Nocturnas prev.`, `Caract. Prales.`, `Creador`, `Código Línea`, `Oferta`, `Dirección Cliente`, `Cód. Postal Cliente`, `Municipio Cliente`, `Provincia Cliente`, `Comunidad Cliente`, `Titular`, `NIF Titular`, `Cód. Postal Inspección`, `Dirección Inspección`, `Población Inspección`, `Precio Ud.`, `Ud.`, `Tot.Contr+Subc+Com`, `Total Ped. Con IVA`, `Tot. IVA`, `Tot. Facturado`, `Responsable`, `Empl. Ventas`, `Email Comunicaciones`, `Teléfono`, `Contacto`, `Materia`, `Tot. Tasas`, `Tot. Subc.`, `Tot. Com.`, `Email Contacto`

---

## 🔍 Módulo: Auditoría de Pedidos (`public/index.html`)

Módulo que valida líneas de pedido exportadas de SAP. Carga dos Excel (cabeceras + líneas), detecta errores de datos y precios fuera de tarifa.

---

### ⚙️ Función `tipoServicio(codigo)`

Clasifica el código SAP en un tipo interno. **Orden importante** — los más específicos van primero:

| Tipo interno | Detecta |
|---|---|
| `AEGT` | Grúas Torre |
| `AEGA` | Grúas Autopropulsadas |
| `EICIAE` | EICI Ascensores (antes que AE) |
| `AE` | Ascensores (OCAAE, \bAE\b) |
| `REBTFV` | Fotovoltaica |
| `REBT_GARAJE` | REBT Garaje |
| `REBT_ZC` | REBT Zonas Comunes / CP |
| `REBT_IP` | REBT Instalación Petrolífera |
| `REBT` | REBT genérico |
| `AP_CLASIF` | Clasificación AP ITC EP-6 (sin tarifa) |
| `AP` | Aparatos a Presión |
| `GASOL` | Estaciones de Servicio |
| `SMEX` | Maquinaria Especial |
| `SMMIN_VOLQUETE` / `SMMIN_PALA` / `SMMIN` | Maquinaria Mínima |
| `SM` | Maquinaria General |
| `REAT` | Alta Tensión |
| `IP` | Instalaciones Petrolíferas |
| `RITE` | Instalaciones Térmicas |
| `PI_RIPCI` | Protección Incendios RIPCI |
| `PI_RSCIEI` | Protección Incendios RSCIEI |
| `ESTANTERIAS` | Estanterías |
| `LINEAS_VIDA` | Líneas de Vida |
| `REBT_PF` | REBT Punto Fijo |
| `GENERAL` | Fallback |

---

### 💶 Fórmula de precio (Simecal)

```
Precio = (TPCE + TPIE + km × 0.65) / 60 × tarifaHora + km × 0.16
```

- **tarifaHora**: 106 €/h para todos los servicios. Excepción: AEGT/AEGA/AP en 2ª visita → 100 €/h.
- **km mínimo por servicio** (función `getKmMinimo`):

| Servicio | km mínimo |
|---|---|
| `PI_RIPCI` | 20 km |
| `RITE` | 40 km |
| `REBT` genérico: Concurrencia | 40 km |
| `REBT` genérico: Piscinas | 10 km |
| `REBT` genérico: Riesgo/Explosión | 0 km |
| Resto (REAT, IP, PI_RSCIEI, REBT_ZC, AP…) | 60 km |

---

### 📊 Tablas de precios fijos

#### AE — Ascensores (`AE_PRECIO_UNIT`)
- **Cada línea SAP = 1 ascensor**. El tier se calcula con el total de líneas AE del pedido.
- Validación a nivel de **pedido** (post-proceso), no por línea.

| Tier | ud | Periódica 1ª | Periódica 2ª | Inicial 1ª | Inicial 2ª |
|---|---|---|---|---|---|
| 1 | 1 | 98€ | 64€ | 180€ | 94€ |
| 2 | 2 | 89€ | 51€ | 166€ | 83€ |
| 3 | 3–6 | 85€ | 45€ | 161€ | 81€ |
| 7 | 7+ | 80€ | 38€ | 156€ | 78€ |

#### EICIAE — Inspección EICI Ascensores
- Cada línea SAP = 1 unidad. Precio fijo: **169,60 €/ud**.
- Validación a nivel de **pedido** (post-proceso).

#### AEGT — Grúas Torre (`AEGT_PRECIOS`)
| Subtipo | 1ª p1 | 1ª p2 | Sig. p1 | Sig. p2 |
|---|---|---|---|---|
| Automontante | 202,17€ | 140,33€ | 202,17€ | 93,70€ |
| Torre desmontada | 202,17€ | 140,33€ | 202,17€ | 93,70€ |
| Torre montada | 308,17€ | 193,33€ | 229,67€ | 114,83€ |
| Extraordinaria torre | 414,17€ | 214,53€ | 335,67€ | 136,03€ |
| Extraordinaria automontante | 202,17€ | 140,33€ | 123,67€ | 61,83€ |

#### AEGA — Grúas Autopropulsadas (`AEGA_PRECIOS`)
| Subtipo | 1ª | 2ª |
|---|---|---|
| Con pluma | 467,17€ | 202,17€ |
| Sin pluma | 361,17€ | 202,17€ |

---

### ✅ Validaciones por línea (`validarLinea`)

**Campos obligatorios (todos los servicios):**
- NIF del cliente (JSON embebido)
- Titular · NIF Titular
- Dirección Inspección · Cód. Postal Inspección · Población Inspección
- Contacto · Teléfono · Email Comunicaciones / Email Contacto
- Responsable · Caract. Prales.
- TPCE > 0 · TPIE > 0

**Campos específicos por tipo:**
- `AE` / `EICIAE`: Mantenedor (JSON) · Nº RAE
- `REBT_ZC` / `REBT_GARAJE`: Administrador (JSON)

**Precio:**
- Tolerancia: €0,50 (redondeo)
- Si precio < esperado − 0,50 → error rojo
- `AP_CLASIF`: sin validación de precio (clasificación sin tarifa)

---

### 🔄 Post-proceso por pedido (`procesarPedidos`)

Tras procesar todas las líneas, se validan acumuladamente:
- **AE**: suma precios AE del pedido vs. `n × precio_unit[tier]`
- **EICIAE**: suma precios EICIAE del pedido vs. `n × 169,60€`

---

## 🚀 Comandos

```bash
npm start      # Producción
npm run dev    # Desarrollo con nodemon
```

---

*Última actualización: Abril 2026*
