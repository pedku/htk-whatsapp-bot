// bot.js — WhatsApp Bot HTK INGENIERIA v2
// Máquina de estados: IDLE → MENU → AWAITING_DETAILS → LEAD_COMPLETE
// Sin LLM. Respuestas predefinidas instantáneas.
// Un lead por sesión, enriquecido progresivamente.

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const msgs = require("./messages");
const faq = require("./faq");
// DEPRECATED: const sheets = require("./sheets"); — Ahora todo en CRM
const notify = require("./notify");

// ─── CONSTANTES ──────────────────────────────────────
const ESTADOS = {
  IDLE: "idle",              // Sin conversación activa
  PRESENTACION: "presentacion", // Bot se presenta y pide nombre
  MENU: "menu",              // Menú mostrado, esperando opción
  SUBMENU_EE: "submenu_ee", // Submenú E/E, esperando 1 o 2
  AWAITING_DETAIL: "awaiting_detail", // Esperando datos del cliente
  LEAD_COMPLETE: "lead_complete",     // Lead finalizado, derivado
  CLOSED: "closed",          // Conversación cerrada
  SILENT: "silent",          // Pedro ya atendió, bot no responde
};

// ─── GLOBAL TOGGLE ────────────────────────────────────
let botGlobalOff = false;  // true = bot no procesa NINGÚN mensaje entrante

const leadsPath = path.join(__dirname, "data", "leads.json");
const silencedPath = path.join(__dirname, "data", "silenced.json");
fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
if (!fs.existsSync(leadsPath)) fs.writeFileSync(leadsPath, "[]", "utf-8");
if (!fs.existsSync(silencedPath)) fs.writeFileSync(silencedPath, "[]", "utf-8");

// ─── ACTIVE CHATS v4 — tracking de conversaciones de Pedro ──
// Cuando Pedro escribe a un chat (fromMe), registramos ese chat.
// Cuando llega un mensaje entrante, si Pedro estuvo activo ahí
// en los últimos minutos, el bot NO responde.
//
// CRÍTICO: Usa IDs RAW de WhatsApp (@lid incluido).
// El ID que WhatsApp da como "msg.to" cuando Pedro envía,
// es el MISMO que "msg.from" cuando el lead responde.
// Sin necesidad de resolver formatos.

const activeChats = new Map();  // rawChatId → { lastMsg, untilTs }
const ACTIVE_CHAT_TTL = 30 * 60 * 1000;   // 30 min antes de olvidar el chat
const ACTIVE_COOLDOWN = 5 * 60 * 1000;    // 5 min sin respuesta del lead

function marcarChatActivo(rawChatId) {
  if (!rawChatId || typeof rawChatId !== "string") return;
  if (rawChatId.includes("@g.us")) return;  // Ignorar grupos
  activeChats.set(rawChatId, {
    lastMsg: Date.now(),
    untilTs: Date.now() + ACTIVE_CHAT_TTL,
  });
}

function esChatActivo(rawChatId) {
  if (!rawChatId) return false;
  const entry = activeChats.get(rawChatId);
  if (!entry) return false;
  // Si expiró el TTL total, limpiar
  if (Date.now() > entry.untilTs) {
    activeChats.delete(rawChatId);
    return false;
  }
  // Está activo si Pedro escribió hace menos de ACTIVE_COOLDOWN
  return (Date.now() - entry.lastMsg) < ACTIVE_COOLDOWN;
}

function esChatPedro(rawChatId) {
  if (!rawChatId) return false;
  const entry = activeChats.get(rawChatId);
  if (!entry) return false;
  if (Date.now() > entry.untilTs) {
    activeChats.delete(rawChatId);
    return false;
  }
  return true;  // Pedro estuvo aquí
}

// Limpieza periódica de chats expirados
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of activeChats) {
    if (now > entry.untilTs) activeChats.delete(id);
  }
}, 60000);  // cada minuto

// ─── SILENCED v4 — simplificado, solo para API sends ──
// El silencedMap ahora guarda números EN AMBOS FORMATOS
// (@c.us y @lid) para cubrir cualquier escenario.
// Persiste en disco para sobrevivir reinicios.
let silencedMap = new Map();

function normalizarNumero(numero) {
  if (!numero || typeof numero !== "string") return "";
  // Asegurar @c.us si no tiene sufijo
  let n = numero.includes("@") ? numero : `${numero}@c.us`;
  // Quitar +
  n = n.replace(/^\+/, "");
  return n;
}

function silenciarNumero(numero) {
  if (!numero || typeof numero !== "string") return;
  const normalizado = normalizarNumero(numero);
  silencedMap.set(normalizado, Date.now());
  // Guardar también raw (por si llega como @lid)
  if (numero !== normalizado && numero.length > 5) {
    silencedMap.set(numero, Date.now());
  }
  guardarSilenced();
}

function estaSilenciado(numero) {
  if (!numero) return false;
  // Buscar primero tal cual
  if (silencedMap.has(numero)) return true;
  // Buscar normalizado
  const norm = normalizarNumero(numero);
  if (norm && silencedMap.has(norm)) return true;
  return false;
}

function unsilenciarNumero(numero) {
  if (!numero) return false;
  const deleted = silencedMap.delete(numero);
  const deleted2 = silencedMap.delete(normalizarNumero(numero));
  if (deleted || deleted2) guardarSilenced();
  return deleted || deleted2;
}

function guardarSilenced() {
  try {
    const data = [];
    const validKeys = ["@c.us", "@lid", "@s.whatsapp.net"];
    for (const key of silencedMap.keys()) {
      // Solo guardar si tiene formato de número válido
      if (key && key.length > 5 && validKeys.some(s => key.includes(s))) {
        data.push(key);
      }
    }
    fs.writeFileSync(silencedPath, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) { console.error("Error guardando silenced.json:", e.message); }
}

// Cargar silencedMap desde disco
(function cargarSilenced() {
  try {
    if (fs.existsSync(silencedPath)) {
      const saved = JSON.parse(fs.readFileSync(silencedPath, "utf-8"));
      if (Array.isArray(saved)) {
        for (const item of saved) {
          if (typeof item === "string") {
            silencedMap.set(item, Date.now());
          } else if (item && item.num) {
            // Formato antiguo con { num, untilTs, reason }
            silencedMap.set(item.num, Date.now());
          }
        }
      }
      console.log(`🔇 ${silencedMap.size} números silenciados cargados`);
    }
  } catch (e) {
    console.log("🔇 Sin silenced.json previo");
  }
})();

// ─── FUNCIONES BASE ───────────────────────────────────
function personalizar(texto, nombre) {
  return texto.replace(/\{nombre\}/g, nombre || "👤");
}

function horaCO() {
  return new Date().toLocaleString("es-CO", {
    timeZone: "America/Bogota",
    hour: "2-digit", minute: "2-digit",
    day: "2-digit", month: "2-digit",
  });
}

function estaEnHorario() {
  const ahora = new Date();
  const dia = ahora.getDay();
  const hora = ahora.getHours();
  if (dia === 0) return false;
  if (dia === 6) return hora >= config.horario.sabado.inicio && hora < config.horario.sabado.fin;
  return hora >= config.horario.semana.inicio && hora < config.horario.semana.fin;
}

// ─── LEADS (agregación por sesión) ────────────────────
// Un lead por sesión, se enriquece progresivamente
// Solo se guarda definitivamente cuando está COMPLETO
function guardarLeads() {
  try {
    const all = [];
    for (const s of sessions.values()) {
      if (s.leadFinalizado && s.lead) all.push(s.lead);
    }
    const exists = JSON.parse(fs.readFileSync(leadsPath, "utf-8"));
    // Append nuevos (evitar duplicados por hora exacta)
    for (const l of all) {
      if (!exists.some(e => e.fecha === l.fecha)) exists.push(l);
    }
    if (exists.length > 500) exists.splice(0, exists.length - 500);
    fs.writeFileSync(leadsPath, JSON.stringify(exists, null, 2), "utf-8");
  } catch (e) { console.error("Error guardando leads:", e.message); }
}

// ─── Sincronizar con CRM Flask ────────────
function sincronizarCRM(lead) {
  const http = require("http");
  const data = JSON.stringify({
    fecha: lead.fecha,
    numero: lead.numero || "",
    nombre: lead.nombre || "",
    canal: lead.canal || "WhatsApp",
    opcion: lead.opcion || "",
    detalle: lead.detalle || "",
  });

  const req = http.request({
    hostname: "localhost",
    port: 18800,
    path: "/api/leads",
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    timeout: 3000,
  }, (res) => {
    let body = "";
    res.on("data", c => body += c);
    res.on("end", () => {
      if (res.statusCode === 201) console.log("✅ CRM: lead sincronizado");
      else console.log("⚠️ CRM: respuesta " + res.statusCode);
    });
  });
  req.on("error", () => {});  // CRM caído? No importa, ya está en JSON
  req.write(data);
  req.end();
}

function finalizarLead(session) {
  if (!session.lead) return null;
  session.lead.fecha = new Date().toISOString();
  session.lead.atendido = false;
  session.leadFinalizado = true;
  const lead = { ...session.lead };
  guardarLeads();

  // DEPRECATED: Google Sheets → Ahora todo en CRM SQLite
  // sheets.agregarLead(lead).catch(() => {});

  // Notificar al instante (sin cron, sin polling)
  notify.notificarLead(lead);

  // Sincronizar con CRM Flask (SQLite)
  sincronizarCRM(lead);

  return lead;
}

// ─── FAQ ─────────────────────────────────────────────
function detectarFAQ(texto) {
  const t = texto.toLowerCase().trim();
  let best = null, bestPrio = 0;
  for (const entry of faq.entries) {
    for (const kw of entry.keywords) {
      if (t.includes(kw.toLowerCase()) && entry.priority > bestPrio) {
        bestPrio = entry.priority;
        best = entry.response;
        break;
      }
    }
  }
  return best;
}

// ─── DETECCIÓN DE OPCIÓN ────────────────────────────
function detectarOpcion(texto, estado) {
  const t = texto.toLowerCase().trim();

  // Comandos GLOBALES (funcionan en cualquier estado)
  if (t.includes("urgente")) return "urgente";
  if (/^(menu|menú|inicio|empezar|volver|atrás|start|comenzar|reiniciar)$/i.test(t)) return "reset";
  if (/^(gracias|ok|okey|bye|chao|adios|listo|thanks|thank you|dale|si|sí|de acuerdo|ok ok|okey dokey)$/i.test(t)) return "despedida";

  // Si está esperando datos del cliente → NO revisar keywords ni números de menú
  if (estado === ESTADOS.AWAITING_DETAIL) {
    return "detalle"; // Todo lo que escriba es un detalle
  }

  // Submenú E/E
  if (estado === ESTADOS.SUBMENU_EE) {
    if (/^[12]$/.test(t)) return `sub_${t}`;
    // Si no es 1 o 2, igual tratar como detalle si viene de E/E
    return "detalle";
  }

  // Menú principal: números 1-6
  if (/^[1-6]$/.test(t)) return parseInt(t);

  // Palabras clave (solo cuando NO está en modo detalle)
  for (const [keyword, opcion] of Object.entries(config.keywords)) {
    if (t.includes(keyword)) return opcion;
  }

  // FAQ
  const faqRespuesta = detectarFAQ(texto);
  if (faqRespuesta) return { tipo: "faq", texto: faqRespuesta };

  // Nada reconocible
  return null;
}

// ─── RESPUESTAS POR ESTADO ──────────────────────────
function responder(session, estado, opcion, texto, nombre) {
  const n = nombre || "👤";
  const p = (msg) => personalizar(msg, n);

  switch (estado) {

    // ─── IDLE: presentación y pedir nombre ────
    case ESTADOS.IDLE: {
      const enHorario = estaEnHorario();
      if (!enHorario) {
        session.estado = ESTADOS.SILENT;
        return p(msgs.fuera_horario);
      }
      session.lead = {
        numero: session.numero,
        nombre: "",
        canal: "WhatsApp",
        opcion: "Nuevo contacto",
        detalle: texto,
      };
      session.estado = ESTADOS.PRESENTACION;
      return p(msgs.presentacion);
    }

    // ─── PRESENTACION: capturar nombre ─────────
    case ESTADOS.PRESENTACION: {
      // Guardar lo que dijo como posible nombre
      const nombreIngresado = texto.trim().substring(0, 60) || "👤";
      session.lead.nombre = nombreIngresado;
      session.nombre = nombreIngresado;

      session.estado = ESTADOS.MENU;
      // Forzar personalización con el nombre capturado
      return personalizar(msgs.bienvenida, nombreIngresado);
    }

    // ─── MENU: opción recibida ────────────────────
    case ESTADOS.MENU: {
      if (typeof opcion === "number") {
        session.lead.opcion = ["", "Reparación de equipos", "Elevadores y Estabilizadores",
          "Automatización", "Cargadores", "IoT", "Otra consulta"][opcion] || "Opción " + opcion;

        // Opción 2 → submenú E/E
        if (opcion === 2) {
          session.estado = ESTADOS.SUBMENU_EE;
          return p(msgs.submenu_elev_estab);
        }

        // Para las demás opciones: mostrar info + pedir datos
        const msgMap = { 1: msgs.reparacion_equipos, 3: msgs.automatizacion,
          4: msgs.cargadores, 5: msgs.iot, 6: msgs.otra_consulta };
        const respuesta = msgMap[opcion] || msgs.default;
        session.estado = ESTADOS.AWAITING_DETAIL;
        return p(respuesta);
      }

      // Si es FAQ en estado MENU
      if (opcion && opcion.tipo === "faq") {
        return p(opcion.texto);
      }

      // Si es keyword que matchea
      if (typeof opcion === "number") {
        return responder(session, ESTADOS.MENU, opcion, texto, n);
      }

      // No se reconoció
      session.autoCount = (session.autoCount || 0) + 1;
      if (session.autoCount >= config.maxAutoMensajes) {
        const lead = finalizarLead(session);
        session.estado = ESTADOS.SILENT;
        return p(msgs.derivar_ingeniero);
      }
      return p(msgs.reintento);
    }

    // ─── SUBMENU E/E: sub-opción recibida ─────────
    case ESTADOS.SUBMENU_EE: {
      if (opcion === "sub_1") {
        session.lead.opcion = "Elevadores de voltaje";
        session.lead.detalle = texto;
        session.estado = ESTADOS.AWAITING_DETAIL;
        return p(msgs.elevadores);
      }
      if (opcion === "sub_2") {
        session.lead.opcion = "Estabilizadores";
        session.lead.detalle = texto;
        session.estado = ESTADOS.AWAITING_DETAIL;
        return p(msgs.estabilizadores);
      }
      // Si no es sub-opción válida, tratar como detalle
      session.lead.opcion = "Elevadores y Estabilizadores";
      session.lead.detalle = texto;
      session.estado = ESTADOS.AWAITING_DETAIL;
      // Mostrar info general de E/E y pedir detalles
      return p(msgs.submenu_elev_estab + "\n\n" + "¿Qué tipo de equipo necesitas, " + n + "? Cuéntanos tu caso y un ingeniero te asesorará.");
    }

    // ─── AWAITING DETAIL: cliente dando info ──────
    case ESTADOS.AWAITING_DETAIL: {
      // Acumular detalle (no reemplazar)
      const prev = session.lead.detalle || "";
      session.lead.detalle = prev ? prev + " | " + texto : texto;

      // Finalizar lead
      finalizarLead(session);
      session.estado = ESTADOS.SILENT;

      return p(msgs.derivar_ingeniero);
    }

    // ─── SILENT: Pedro atendió, bot no responde ──
    case ESTADOS.SILENT:
    case ESTADOS.CLOSED: {
      // Modo silencioso — bot no interfiere en la conversación
      // El cliente quedó en manos de Pedro
      return null;
    }

    default:
      return p(msgs.default);
  }
}

// ─── SESIONES ─────────────────────────────────────────
const sessions = new Map();

function getSession(numero) {
  let s = sessions.get(numero);
  if (!s) {
    s = {
      numero,
      estado: ESTADOS.IDLE,
      lead: null,
      leadFinalizado: false,
      autoCount: 0,
      lastMsg: 0,
      nombre: "",
    };
    sessions.set(numero, s);
  }
  return s;
}

// ─── CLIENTE WHATSAPP ────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "htk-bot", dataPath: path.join(__dirname, "session-data") }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  },
});

client.on("qr", (qr) => {
  console.log("\n🔐 QR generado. Escanea con WhatsApp.");
  qrcode.generate(qr, { small: true });
  console.log("\n");
});

client.on("ready", () => {
  console.log("✅ Bot HTK conectado y listo.");
  console.log(`📱 Número: ${config.botNumber}`);
  console.log(`⏰ Horario: Lun-Vie ${config.horario.semana.inicio}-${config.horario.semana.fin}, Sáb ${config.horario.sabado.inicio}-${config.horario.sabado.fin}`);
  // DEPRECATED: sheets.inicializar(); — CRM SQLite gestiona todo
  console.log("💾 CRM: SQLite local (http://localhost:18800)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
});

client.on("authenticated", () => console.log("🔐 Sesión autenticada."));

// ─── MANEJADOR DE MENSAJES ──────────────────────────
client.on("message", async (msg) => {
  try {
    const from = msg.from;
    const texto = msg.body.trim();
    
    // ─── IGNORAR GRUPOS ──────────────────────────
    if (from.includes("@g.us")) return;

    // ─── MENSAJES DEL PROPIETARIO (Pedro) ────────
    if (msg.fromMe || from === config.botNumber.replace(/^\+/, "") + "@c.us") {
      // Los comandos se manejan desde el CRM (no desde WhatsApp)
      // para evitar dejar rastro en chats de leads.
      // Ver CRM → lead → botón "Silenciar"
      
      // AUTO-SILENCE: cada msg de Pedro → marcar chat activo
      if (msg.to && !msg.to.includes("@g.us")) {
        marcarChatActivo(msg.to);
        silenciarNumero(msg.to);
        console.log(`🔇 Pedro activo en ${msg.to} → bot silenciado automático`);
      }
      return;
    }

    // ─── BOT GLOBALMENTE APAGADO? ──
    if (botGlobalOff) {
      console.log(`🛑 Bot global apagado, ignorando: ${from}`);
      return;
    }

    // ─── CHAT ACTIVO? Pedro está conversando aquí ──
    if (esChatActivo(from)) {
      const s = getSession(from);
      s.lastMsg = Date.now();
      console.log(`🟢 Chat activo (Pedro), ignorando: ${from}`);
      return;
    }

    // ─── SILENCED? El bot no debe responder ──
    if (estaSilenciado(from)) {
      const s = getSession(from);
      s.lastMsg = Date.now();
      console.log(`🔇 Silenciado escribe: ${from} → ignorado`);
      return;
    }

    console.log(`📩 Mensaje de ${from}: "${texto.substring(0, 80)}"`);

    const session = getSession(from);
    session.numero = from;

    const nombre = session.nombre || "👤";

    // Timeout: 30 min sin actividad → reset (excepto sesiones outbound/silent)
    const ahora = Date.now();
    if (session.lastMsg && (ahora - session.lastMsg) > config.resetTimeoutMs) {
      if (!session.atendidoPorPedro && session.estado !== ESTADOS.SILENT) {
        session.estado = ESTADOS.IDLE;
        session.lead = null;
        session.leadFinalizado = false;
        session.autoCount = 0;
      } else {
        // Sesión outbound/silent: mantener estado, solo actualizar timestamp
        session.lastMsg = ahora;
      }
    }
    session.lastMsg = ahora;

    const enHorario = estaEnHorario();

    // Detectar comando/opción según el estado actual
    const opcion = detectarOpcion(texto, session.estado);

    // ─── COMANDOS GLOBALES ──────────────────────

    // URGENTE desde cualquier estado
    if (opcion === "urgente") {
      session.lead = session.lead || { numero: from, nombre, canal: "WhatsApp" };
      session.lead.opcion = "URGENTE";
      session.lead.detalle = texto;
      finalizarLead(session);
      session.estado = ESTADOS.SILENT;
      await msg.reply(personalizar(msgs.urgente_recibido, nombre));
      await new Promise(r => setTimeout(r, 1000));
      await msg.reply(personalizar(msgs.derivar_ingeniero, nombre));
      return;
    }

    // RESET desde cualquier estado
    if (opcion === "reset") {
      session.estado = ESTADOS.IDLE;
      session.lead = null;
      session.leadFinalizado = false;
      session.autoCount = 0;
      session.nombre = "";
      if (!enHorario) {
        await msg.reply(personalizar(msgs.fuera_horario, nombre));
        return;
      }
      await msg.reply(personalizar(msgs.presentacion, "👤"));
      session.lead = { numero: from, nombre: "", canal: "WhatsApp", opcion: "Nuevo contacto", detalle: texto };
      session.estado = ESTADOS.PRESENTACION;
      return;
    }

    // DESPEDIDA desde cualquier estado
    if (opcion === "despedida") {
      await msg.reply(personalizar(msgs.despedida, nombre));
      session.estado = ESTADOS.SILENT;
      return;
    }

    // ─── FUERA DE HORARIO ───────────────────────
    if (!enHorario && session.estado !== ESTADOS.IDLE) {
      await msg.reply(personalizar(msgs.fuera_horario, nombre));
      return;
    }

    // ─── PROCESAR SEGÚN ESTADO ─────────────────
    const respuesta = responder(session, session.estado, opcion, texto, nombre);
    if (respuesta) {
      await msg.reply(respuesta);
    }

  } catch (error) {
    console.error("❌ Error:", error.message);
  }
});

// ─── API HTTP PARA ENVÍO DE MENSAJES ───────────────
const http = require("http");
const API_PORT = 18802;

const apiServer = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  
  // CORS para llamadas locales
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  
  if (req.method !== "POST") {
    res.writeHead(404);
    return res.end(JSON.stringify({ error: "Solo POST" }));
  }

  let body = "";
  req.on("data", chunk => body += chunk);
  req.on("end", async () => {
    try {
      const data = JSON.parse(body);
      
      if (req.url === "/send") {
        const { to, message } = data;
        if (!to || !message) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "Faltan 'to' o 'message'" }));
        }
        const fullNumber = normalizarNumero(to);
        const chat = await client.getChatById(fullNumber);
        await chat.sendStateTyping();
        await new Promise(r => setTimeout(r, 1500));
        const sentMsg = await client.sendMessage(fullNumber, message);
        const realChatId = sentMsg?.to || fullNumber;
        silenciarNumero(fullNumber);
        if (realChatId !== fullNumber && realChatId !== to) {
          silenciarNumero(realChatId);
          console.log(`🔇 También silenciado ID real: ${realChatId}`);
        }
        marcarChatActivo(realChatId);
        const outboundSession = getSession(realChatId);
        outboundSession.estado = ESTADOS.SILENT;
        outboundSession.lastMsg = Date.now();
        outboundSession.lead = outboundSession.lead || { numero: realChatId, nombre: "Prospección outbound", canal: "WhatsApp", opcion: "Prospección", detalle: "Mensaje de prospección enviado por API" };
        outboundSession.leadFinalizado = true;
        outboundSession.atendidoPorPedro = true;
        console.log(`✅ Mensaje enviado a ${realChatId} 🔇 silenciado`);
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, to: fullNumber }));
      }
      
      if (req.url === "/silence") {
        const { numero } = data;
        if (!numero) { res.writeHead(400); return res.end(JSON.stringify({ error: "Falta 'numero'" })); }
        silenciarNumero(normalizarNumero(numero));
        console.log(`🔇 Silenciado vía API: ${numero}`);
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true }));
      }
      
      if (req.url === "/unsilence") {
        const { numero } = data;
        if (!numero) { res.writeHead(400); return res.end(JSON.stringify({ error: "Falta 'numero'" })); }
        unsilenciarNumero(normalizarNumero(numero));
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true }));
      }
      
      if (req.url === "/global-off") {
        botGlobalOff = true;
        console.log(`🛑 Bot global APAGADO vía API`);
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, status: "off" }));
      }
      
      if (req.url === "/global-on") {
        botGlobalOff = false;
        console.log(`🟢 Bot global ENCENDIDO vía API`);
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, status: "on" }));
      }
      
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Ruta no encontrada" }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

apiServer.listen(API_PORT, () => {
  console.log(`📨 API de envío en http://localhost:${API_PORT}/send`);
});

// ─── INICIAR ─────────────────────────────────────────
console.log("🚀 Iniciando Bot HTK v2...");
client.initialize();
