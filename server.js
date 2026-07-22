import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { z } from "zod";
import fs from "node:fs/promises";

const app = express();
const PORT = process.env.PORT || 3000;
const CFE_URL = "https://app.cfe.mx/Aplicaciones/CCFE/ReciboDeLuzGMX/Consulta";

// ============================================================
// CONFIGURACIÓN - SMARTPROXY (3GB)
// ============================================================
const PROXY_USERNAME = "spp9625kp7";  // ← CAMBIA ESTO
const PROXY_PASSWORD = "w3rn85=sdkit1JSjIP";  // ← CAMBIA ESTO
const PROXY_SERVER = "gate.smartproxy.com";
const PROXY_PORT = 10000;

// Configuración de reintentos
const MAX_RETRIES = 3;
const RETRY_DELAY = 3000;

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
// TEST DE PROXY
// ============================================================
app.get("/proxy-test", async (req, res) => {
  let browser;
  try {
    const config = {
      server: `http://${PROXY_SERVER}:${PROXY_PORT}`,
      username: PROXY_USERNAME,
      password: PROXY_PASSWORD,
    };
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
      mensaje: "✅ Proxy SmartProxy funcionando",
    });
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    res.json({ ok: false, error: error.message });
  }
});

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
// FUNCIÓN PARA INTENTAR OBTENER EL RECIBO
// ============================================================
async function intentarObtenerRecibo(parsed) {
  let lastError = null;
  
  for (let intento = 1; intento <= MAX_RETRIES; intento++) {
    console.log(`\n🔄 INTENTO ${intento} de ${MAX_RETRIES}`);
    
    let browser = null;
    
    try {
      const config = {
        server: `http://${PROXY_SERVER}:${PROXY_PORT}`,
        username: PROXY_USERNAME,
        password: PROXY_PASSWORD,
      };
      
      console.log(`🔑 Usando proxy: ${config.server}`);
      
      browser = await chromium.launch({
        headless: true,
        proxy: config,
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

      console.log("🌐 Navegando a CFE...");
      const navigationResponse = await page.goto(CFE_URL, {
        waitUntil: "networkidle",
        timeout: 60000,
      });

      const statusCode = navigationResponse?.status() ?? 0;
      console.log(`📡 CFE STATUS: ${statusCode}`);

      const html = await page.content();
      if (html.includes("Incapsula") || html.includes("_Incapsula_Resource")) {
        console.log("🚫 IP bloqueada por Incapsula");
        throw new Error("IP bloqueada por Incapsula");
      }

      const nombreField = page.locator("#MainContent_txtNombre");
      const nombreCount = await nombreField.count();
      console.log(`📝 CAMPO NOMBRE ENCONTRADO: ${nombreCount}`);

      if (nombreCount === 0) {
        throw new Error("El formulario de CFE no apareció.");
      }

      await page.waitForTimeout(2000);

      console.log("📝 Llenando formulario...");
      await safeFill(page, "#MainContent_txtNombre", parsed.nombreCompleto);
      await safeFill(page, "#MainContent_txtRPU", parsed.numeroServicio);
      await safeFill(page, "#MainContent_tbLada", parsed.lada);
      await safeFill(page, "#MainContent_txtTel", parsed.telefonoFijo);
      await safeFill(page, "#MainContent_txtCel", parsed.celular);
      await safeFill(page, "#MainContent_txtCorreoElectronico", parsed.correo);

      console.log("🔄 Enviando formulario...");
      const continuarBtn = page.locator("#MainContent_btnContinuar");
      await continuarBtn.waitFor({ state: "visible", timeout: 10000 });
      await continuarBtn.click();

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

      console.log("📄 Descargando PDF...");
      const downloadBtn = filaEncontrada.locator('input[type="image"][title="Descarga Pdf"]');
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
      
      return { success: true, pdfBuffer, numeroServicio: parsed.numeroServicio };

    } catch (error) {
      console.error(`❌ Intento ${intento} falló:`, error.message);
      lastError = error;
      
      if (browser) {
        await browser.close().catch(() => {});
      }
      
      if (intento < MAX_RETRIES) {
        console.log(`⏳ Esperando ${RETRY_DELAY/1000} segundos...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      }
    }
  }
  
  throw new Error(`Todos los ${MAX_RETRIES} intentos fallaron. Último error: ${lastError?.message || 'Desconocido'}`);
}

// ============================================================
// ENDPOINT PRINCIPAL
// ============================================================
app.post("/obtener-recibo", async (request, response) => {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: "Datos inválidos." });
  }

  try {
    console.log("=".repeat(60));
    console.log("🚀 INICIANDO PROCESO CON SMARTPROXY");
    console.log("=".repeat(60));
    console.log(`👤 Usuario: ${parsed.data.nombreCompleto}`);
    console.log(`🔢 Servicio: ${parsed.data.numeroServicio}`);
    console.log("=".repeat(60));

    const resultado = await intentarObtenerRecibo(parsed.data);
    
    if (resultado.success) {
      console.log("=".repeat(60));
      console.log("✅ PROCESO COMPLETADO CON ÉXITO");
      console.log("=".repeat(60));
      
      response.setHeader("Content-Type", "application/pdf");
      response.setHeader("Content-Disposition", `attachment; filename="recibo-${resultado.numeroServicio}.pdf"`);
      response.setHeader("Cache-Control", "no-store, max-age=0");
      return response.status(200).send(resultado.pdfBuffer);
    }

  } catch (error) {
    console.error("=".repeat(60));
    console.error("❌ ERROR FINAL:", error.message);
    console.error("=".repeat(60));
    
    if (!response.headersSent) {
      return response.status(500).json({
        error: "No fue posible obtener el recibo. Verifica los datos o intenta más tarde.",
      });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("=".repeat(60));
  console.log(`✅ Servidor activo en el puerto ${PORT}`);
  console.log(`🔑 Proxy: SmartProxy (gate.smartproxy.com:10000)`);
  console.log(`🔄 Reintentos: ${MAX_RETRIES}`);
  console.log("=".repeat(60));
});
