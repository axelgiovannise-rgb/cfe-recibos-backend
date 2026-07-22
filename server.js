import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { z } from "zod";
import fs from "node:fs/promises";

const app = express();
const PORT = process.env.PORT || 3000;
const CFE_URL = "https://app.cfe.mx/Aplicaciones/CCFE/ReciboDeLuzGMX/Consulta";

// ============================================================
// CONFIGURACIÓN - SMARTPROXY
// ============================================================
// 🔑 REEMPLAZA CON TUS CREDENCIALES DE SMARTPROXY
const SMART_PROXY_USERNAME = "spp9625kp7";      // ← CAMBIA ESTO
const SMART_PROXY_PASSWORD = "w3rn85=sdkit1JSjIP";   // ← CAMBIA ESTO

const PROXY_CONFIG = {
  server: "http://gate.smartproxy.com:10000",
  username: SMART_PROXY_USERNAME,
  password: SMART_PROXY_PASSWORD,
};

// Puertos alternativos por si el principal falla
const PROXY_PORTS = [10000, 10001, 10002, 10003];

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);
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
// ENDPOINTS BÁSICOS
// ============================================================
app.get("/", (req, res) =>
  res.json({ ok: true, servicio: "Backend de recibos activo" })
);
app.get("/health", (req, res) => res.json({ ok: true }));

// ============================================================
// TEST DE PROXY (CON RECONEXIÓN AUTOMÁTICA)
// ============================================================
app.get("/proxy-test", async (req, res) => {
  let browser;
  try {
    console.log("🔄 Probando proxy SmartProxy...");
    browser = await chromium.launch({
      headless: true,
      proxy: {
        server: PROXY_CONFIG.server,
        username: PROXY_CONFIG.username,
        password: PROXY_CONFIG.password,
      },
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.goto("https://api.ipify.org?format=json", { timeout: 30000 });
    const content = await page.textContent("body");
    await browser.close();
    res.json({
      ok: true,
      ip: JSON.parse(content).ip,
      proxy: PROXY_CONFIG.server,
      mensaje: "✅ Proxy SmartProxy funcionando correctamente",
    });
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    res.json({ ok: false, error: error.message });
  }
});

// ============================================================
// FUNCIÓN PARA PROBAR UN PROXY
// ============================================================
async function probarProxy(config) {
  let browser;
  try {
    console.log(`🔄 Probando proxy: ${config.server}`);
    browser = await chromium.launch({
      headless: true,
      proxy: {
        server: config.server,
        username: config.username,
        password: config.password,
      },
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.goto("https://api.ipify.org?format=json", { timeout: 30000 });
    const content = await page.textContent("body");
    await browser.close();
    const ip = JSON.parse(content).ip;
    console.log(`✅ Proxy funciona. IP: ${ip}`);
    return { ok: true, ip, proxy: config };
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    console.log(`❌ Proxy ${config.server} falló: ${error.message}`);
    return { ok: false, error: error.message, proxy: config };
  }
}

// ============================================================
// FUNCIÓN PARA ENCONTRAR PROXY FUNCIONANDO
// ============================================================
async function encontrarProxyFuncionando() {
  // Primero probar el puerto principal
  const configPrincipal = {
    server: PROXY_CONFIG.server,
    username: PROXY_CONFIG.username,
    password: PROXY_CONFIG.password,
  };
  
  const resultado = await probarProxy(configPrincipal);
  if (resultado.ok) {
    return resultado;
  }
  
  // Si falla, probar puertos alternativos
  const puertosMezclados = [...PROXY_PORTS].sort(() => Math.random() - 0.5);
  
  for (const puerto of puertosMezclados) {
    const config = {
      server: `http://gate.smartproxy.com:${puerto}`,
      username: SMART_PROXY_USERNAME,
      password: SMART_PROXY_PASSWORD,
    };
    const resultado = await probarProxy(config);
    if (resultado.ok) {
      return resultado;
    }
  }
  
  throw new Error(
    "❌ No se encontró ningún proxy funcionando. Verifica tus credenciales de SmartProxy."
  );
}

// ============================================================
// FUNCIÓN PARA VERIFICAR BLOQUEO DE CFE
// ============================================================
async function verificarBloqueoCFE(page) {
  const html = await page.content();
  
  // Detectar Incapsula
  if (html.includes("Incapsula") || html.includes("_Incapsula_Resource")) {
    console.log("🚫 IP bloqueada por Incapsula");
    return true;
  }
  
  // Detectar formulario
  const nombreField = page.locator("#MainContent_txtNombre");
  const count = await nombreField.count();
  
  if (count === 0) {
    console.log("🚫 Formulario no visible - posible bloqueo");
    return true;
  }
  
  console.log("✅ IP funciona correctamente");
  return false;
}

// ============================================================
// FUNCIÓN PARA LLENAR CAMPOS CON SEGURIDAD
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
// LÓGICA DEL BIMESTRE (CADA 2 MESES)
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

  const meses = [
    "ene",
    "feb",
    "mar",
    "abr",
    "may",
    "jun",
    "jul",
    "ago",
    "sep",
    "oct",
    "nov",
    "dic",
  ];
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

  try {
    // ============================================================
    // 1. ENCONTRAR PROXY FUNCIONANDO
    // ============================================================
    console.log("🔍 Buscando proxy SmartProxy funcionando...");
    const resultado = await encontrarProxyFuncionando();
    proxyConfig = resultado.proxy;
    console.log(`🔑 Usando proxy: ${proxyConfig.server} (IP: ${resultado.ip})`);

    // ============================================================
    // 2. ABRIR NAVEGADOR
    // ============================================================
    console.log("🔄 Abriendo navegador con proxy...");

    browser = await chromium.launch({
      headless: true,
      proxy: {
        server: proxyConfig.server,
        username: proxyConfig.username,
        password: proxyConfig.password,
      },
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
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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

    // Verificar bloqueo
    const bloqueado = await verificarBloqueoCFE(page);
    if (bloqueado) {
      throw new Error(
        "IP bloqueada por CFE. Reintentando con otro proxy..."
      );
    }

    const pageTitle = await page.title();
    console.log(`CFE TITLE: ${pageTitle}`);

    // ============================================================
    // 4. VERIFICAR FORMULARIO
    // ============================================================
    const nombreField = page.locator("#MainContent_txtNombre");
    const nombreCount = await nombreField.count();
    console.log(`CAMPO NOMBRE ENCONTRADO: ${nombreCount}`);

    if (nombreCount === 0) {
      throw new Error("El formulario de CFE no apareció.");
    }

    await page.waitForTimeout(2000);

    // ============================================================
    // 5. LLENAR FORMULARIO
    // ============================================================
    console.log("📝 Llenando formulario...");

    await safeFill(
      page,
      "#MainContent_txtNombre",
      parsed.data.nombreCompleto
    );
    await safeFill(page, "#MainContent_txtRPU", parsed.data.numeroServicio);
    await safeFill(page, "#MainContent_tbLada", parsed.data.lada);
    await safeFill(page, "#MainContent_txtTel", parsed.data.telefonoFijo);
    await safeFill(page, "#MainContent_txtCel", parsed.data.celular);
    await safeFill(
      page,
      "#MainContent_txtCorreoElectronico",
      parsed.data.correo
    );

    // ============================================================
    // 6. ENVIAR FORMULARIO
    // ============================================================
    console.log("🔄 Enviando formulario...");
    const continuarBtn = page.locator("#MainContent_btnContinuar");
    await continuarBtn.waitFor({ state: "visible", timeout: 10000 });
    await continuarBtn.click();

    // ============================================================
    // 7. ESPERAR RESULTADOS
    // ============================================================
    console.log("⏳ Esperando resultados...");
    await page.waitForSelector("#MainContent_GVHistorial", { timeout: 30000 });
    console.log("✅ Tabla de recibos cargada");

    const mesBuscado = getMesBuscado();
    console.log(`🔍 Buscando recibo de: ${mesBuscado}`);

    const filas = await page.locator("#MainContent_GVHistorial tr").all();
    let filaEncontrada = null;

    for (let i = 0; i < filas.length; i++) {
      const texto = await filas[i].textContent();
      if (texto && texto.includes(mesBuscado)) {
        filaEncontrada = filas[i];
        console.log(`✅ Encontrado: ${mesBuscado}`);
        break;
      }
    }

    if (!filaEncontrada) {
      console.log(`⚠️ No se encontró ${mesBuscado}, tomando el primer recibo`);
      filaEncontrada = filas[1] || filas[0];
    }

    // ============================================================
    // 8. DESCARGAR PDF
    // ============================================================
    console.log("📄 Descargando PDF...");
    const downloadBtn = filaEncontrada.locator(
      'input[type="image"][title="Descarga Pdf"]'
    );
    await downloadBtn.waitFor({ state: "visible", timeout: 5000 });

    const downloadPromise = page.waitForEvent("download", { timeout: 60000 });
    await downloadBtn.click();
    const download = await downloadPromise;
    const downloadPath = await download.path();

    if (!downloadPath) throw new Error("No se generó el archivo.");

    const pdfBuffer = await fs.readFile(downloadPath);

    if (pdfBuffer.length < 4 || pdfBuffer.subarray(0, 4).toString() !== "%PDF") {
      throw new Error("El archivo no es un PDF válido.");
    }

    await browser.close();
    console.log(`✅ PDF obtenido correctamente (${pdfBuffer.length} bytes)`);

    response.setHeader("Content-Type", "application/pdf");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="recibo-${parsed.data.numeroServicio}.pdf"`
    );
    response.setHeader("Cache-Control", "no-store, max-age=0");
    return response.status(200).send(pdfBuffer);
  } catch (error) {
    console.error("❌ Error:", error);
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (!response.headersSent) {
      return response.status(500).json({
        error:
          "No fue posible obtener el recibo. Verifica los datos e inténtalo nuevamente.",
      });
    }
  }
});

// ============================================================
// INICIO DEL SERVIDOR
// ============================================================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Servidor activo en el puerto ${PORT}`);
  console.log(`🔑 Proxy: SmartProxy configurado`);
  console.log(`📊 Plan: 1GB (~1,000 consultas/mes)`);
  console.log(`🔄 Modo: Reconexión automática`);
});
