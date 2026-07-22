import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { z } from "zod";
import fs from "node:fs/promises";

const app = express();
const PORT = process.env.PORT || 3000;
const CFE_URL = "https://app.cfe.mx/Aplicaciones/CCFE/ReciboDeLuzGMX/Consulta";

// ============================================================
// CONFIGURACIÓN - SMARTPROXY CON ROTACIÓN
// ============================================================
const SMART_PROXY_USERNAME = "spp9625kp7";      // ← CAMBIA ESTO
const SMART_PROXY_PASSWORD = "w3rn85=sdkit1JSjIP";   // ← CAMBIA ESTO

// Puertos rotativos para cambiar de IP
const PROXY_PORTS = [10000, 10001, 10002, 10003];
let currentPortIndex = 0;

function getProxyConfig() {
  const port = PROXY_PORTS[currentPortIndex % PROXY_PORTS.length];
  currentPortIndex++;
  return {
    server: `http://gate.smartproxy.com:${port}`,
    username: SMART_PROXY_USERNAME,
    password: SMART_PROXY_PASSWORD,
  };
}

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors({ origin: true, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type"] }));
app.use(express.json({ limit: "20kb" }));

// ============================================================
// ESQUEMA DE VALIDACIÓN
// ============================================================
const schema = z.object({
  nombreCompleto: z.string().trim().min(3).max(120),
  numeroServicio: z.string().trim().min(1).max(24).regex(/^\d+$/),
  lada: z.string().trim().min(2).max(5).regex(/^\d+$/),
  telefonoFijo: z.string().trim().min(1).max(20).regex(/^\d+$/),
  celular: z.string().trim().min(1).max(20).regex(/^\d+$/),
  correo: z.string().trim().email().max(255),
});

// ============================================================
// ENDPOINTS
// ============================================================
app.get("/", (req, res) => res.json({ ok: true, servicio: "Backend de recibos activo" }));
app.get("/health", (req, res) => res.json({ ok: true }));

// ============================================================
// TEST DE PROXY CON ROTACIÓN
// ============================================================
app.get("/proxy-test", async (req, res) => {
  let browser;
  const config = getProxyConfig();
  try {
    console.log(`🔄 Probando proxy: ${config.server}`);
    browser = await chromium.launch({
      headless: true,
      proxy: config,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.goto("https://api.ipify.org?format=json", { timeout: 30000 });
    const content = await page.textContent("body");
    await browser.close();
    res.json({
      ok: true,
      ip: JSON.parse(content).ip,
      proxy: config.server,
      mensaje: "✅ Proxy funcionando",
    });
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    res.json({ ok: false, error: error.message });
  }
});

// ============================================================
// FUNCIÓN PARA PROBAR PROXY
// ============================================================
async function probarProxy(config) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      proxy: config,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.goto("https://api.ipify.org?format=json", { timeout: 30000 });
    const content = await page.textContent("body");
    await browser.close();
    const ip = JSON.parse(content).ip;
    return { ok: true, ip, proxy: config };
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    return { ok: false, error: error.message, proxy: config };
  }
}

// ============================================================
// FUNCIÓN PARA ENCONTRAR PROXY FUNCIONANDO
// ============================================================
async function encontrarProxyFuncionando() {
  // Probar todos los puertos
  const puertosMezclados = [...PROXY_PORTS].sort(() => Math.random() - 0.5);

  for (const puerto of puertosMezclados) {
    const config = {
      server: `http://gate.smartproxy.com:${puerto}`,
      username: SMART_PROXY_USERNAME,
      password: SMART_PROXY_PASSWORD,
    };
    const resultado = await probarProxy(config);
    if (resultado.ok) {
      console.log(`✅ Proxy encontrado: ${config.server} (IP: ${resultado.ip})`);
      return resultado;
    }
    console.log(`❌ Proxy ${config.server} falló`);
  }

  throw new Error("❌ No se encontró ningún proxy funcionando.");
}

// ============================================================
// FUNCIÓN PARA VERIFICAR BLOQUEO DE CFE
// ============================================================
async function verificarBloqueoCFE(page) {
  const html = await page.content();
  if (html.includes("Incapsula") || html.includes("_Incapsula_Resource")) {
    console.log("🚫 IP bloqueada por Incapsula");
    return true;
  }
  const nombreField = page.locator("#MainContent_txtNombre");
  const count = await nombreField.count();
  if (count === 0) {
    console.log("🚫 Formulario no visible");
    return true;
  }
  console.log("✅ IP funciona correctamente");
  return false;
}

// ============================================================
// FUNCIÓN PARA LLENAR CAMPOS
// ============================================================
async function safeFill(page, selector, value, timeout = 10000) {
  try {
    await page.waitForSelector(selector, { state: "visible", timeout });
    await page.locator(selector).clear();
    await page.locator(selector).fill(value);
    console.log(`✅ Llenado: ${selector}`);
    return true;
  } catch (error) {
    console.log(`⚠️ No se pudo llenar ${selector}: ${error.message}`);
    return false;
  }
}

// ============================================================
// LÓGICA DEL BIMESTRE
// ============================================================
function getMesBuscado() {
  const fecha = new Date();
  const mes = fecha.getMonth();
  const anio = fecha.getFullYear();
  let mesBimestre;
  if (mes % 2 === 0) {
    mesBimestre = mes - 1;
  } else {
    mesBimestre = mes;
  }
  const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const mesTexto = meses[mesBimestre] || "ene";
  const anioTexto = mesBimestre < 0 ? anio - 1 : anio;
  return `${mesTexto} ${anioTexto}`;
}

// ============================================================
// ENDPOINT PRINCIPAL - OBTENER RECIBO
// ============================================================
app.post("/obtener-recibo", async (request, response) => {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: "Datos inválidos." });
  }

  let browser;
  let proxyConfig;
  let intentos = 0;

  try {
    // ============================================================
    // 1. ENCONTRAR PROXY FUNCIONANDO
    // ============================================================
    console.log("🔍 Buscando proxy funcionando...");
    const resultado = await encontrarProxyFuncionando();
    proxyConfig = resultado.proxy;
    console.log(`🔑 Usando proxy: ${proxyConfig.server} (IP: ${resultado.ip})`);

    // ============================================================
    // 2. ABRIR NAVEGADOR
    // ============================================================
    browser = await chromium.launch({
      headless: true,
      proxy: proxyConfig,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    const context = await browser.newContext({
      acceptDownloads: true,
      locale: "es-MX",
      viewport: { width: 1920, height: 1080 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    // ============================================================
    // 3. IR A CFE
    // ============================================================
    console.log("🌐 Navegando a CFE...");
    const navigationResponse = await page.goto(CFE_URL, {
      waitUntil: "networkidle",
      timeout: 60000,
    });

    const statusCode = navigationResponse?.status() ?? 0;
    console.log(`CFE STATUS: ${statusCode}`);

    if (statusCode >= 400) {
      throw new Error(`CFE respondió con estado ${statusCode}`);
    }

    const bloqueado = await verificarBloqueoCFE(page);
    if (bloqueado) {
      throw new Error("IP bloqueada por CFE. Reintentando con otro proxy...");
    }

    // ... resto del código (llenar formulario, descargar PDF) ...
    // (Mantén el resto igual)

  } catch (error) {
    console.error("❌ Error:", error);
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (!response.headersSent) {
      return response.status(500).json({
        error: "No fue posible obtener el recibo. Verifica los datos.",
      });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Servidor activo en el puerto ${PORT}`);
  console.log(`🔑 Proxy: SmartProxy rotativo`);
  console.log(`🔄 Modo: Reconexión automática`);
});
