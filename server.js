import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { z } from "zod";
import fs from "node:fs/promises";

const app = express();
const PORT = process.env.PORT || 3000;
const CFE_URL = "https://app.cfe.mx/Aplicaciones/CCFE/ReciboDeLuzGMX/Consulta";

// ============================================================
// CONFIGURACIÓN - DECODO
// ============================================================
const PROXY_CONFIG = {
  server: 'http://mx.decodo.com:20001',
  username: 'spp9625kp7',
  password: 'w3rn85=sdkit1JSjIP',
};

app.use(cors({ origin: true, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type"] }));
app.use(express.json({ limit: "20kb" }));

const schema = z.object({
  nombreCompleto: z.string().trim().min(3).max(120),
  numeroServicio: z.string().trim().min(1).max(24).regex(/^\d+$/),
  lada: z.string().trim().min(2).max(5).regex(/^\d+$/),
  telefonoFijo: z.string().trim().min(1).max(20).regex(/^\d+$/),
  celular: z.string().trim().min(1).max(20).regex(/^\d+$/),
  correo: z.string().trim().email().max(255),
});

app.get("/", (req, res) => res.json({ ok: true, servicio: "Backend de recibos activo" }));
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/proxy-test", async (req, res) => {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      proxy: PROXY_CONFIG,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    });
    const page = await browser.newPage();
    await page.goto("https://api.ipify.org?format=json", { timeout: 30000 });
    const content = await page.textContent("body");
    await browser.close();
    res.json({
      ok: true,
      ip: JSON.parse(content).ip,
      proxy: PROXY_CONFIG.server,
      mensaje: "✅ Proxy funcionando",
    });
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    res.json({ ok: false, error: error.message });
  }
});

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

app.post("/obtener-recibo", async (request, response) => {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: "Datos inválidos." });
  }

  let browser;

  try {
    console.log("=".repeat(60));
    console.log("🚀 OBTENIENDO RECIBO");
    console.log("=".repeat(60));
    console.log(`👤 Usuario: ${parsed.data.nombreCompleto}`);
    console.log(`🔢 Servicio: ${parsed.data.numeroServicio}`);
    console.log("=".repeat(60));

    browser = await chromium.launch({
      headless: true,
      proxy: PROXY_CONFIG,
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
    page.setDefaultTimeout(90000); // ← Aumentado a 90 segundos

    console.log("🌐 Navegando a CFE...");
    const navigationResponse = await page.goto(CFE_URL, {
      waitUntil: "networkidle",
      timeout: 60000,
    });

    const statusCode = navigationResponse?.status() ?? 0;
    console.log(`📡 CFE STATUS: ${statusCode}`);

    if (statusCode >= 400) {
      throw new Error(`CFE respondió con estado ${statusCode}`);
    }

    const nombreField = page.locator("#MainContent_txtNombre");
    const nombreCount = await nombreField.count();
    console.log(`📝 CAMPO NOMBRE ENCONTRADO: ${nombreCount}`);

    if (nombreCount === 0) {
      throw new Error("El formulario de CFE no apareció.");
    }

    await page.waitForTimeout(2000);

    console.log("📝 Llenando formulario...");
    await safeFill(page, "#MainContent_txtNombre", parsed.data.nombreCompleto);
    await safeFill(page, "#MainContent_txtRPU", parsed.data.numeroServicio);
    await safeFill(page, "#MainContent_tbLada", parsed.data.lada);
    await safeFill(page, "#MainContent_txtTel", parsed.data.telefonoFijo);
    await safeFill(page, "#MainContent_txtCel", parsed.data.celular);
    await safeFill(page, "#MainContent_txtCorreoElectronico", parsed.data.correo);

    console.log("🔄 Enviando formulario...");
    const continuarBtn = page.locator("#MainContent_btnContinuar");
    await continuarBtn.waitFor({ state: "visible", timeout: 10000 });
    await continuarBtn.click();

    console.log("⏳ Esperando resultados... (puede tomar hasta 60 segundos)");

    // Esperar a que cargue la tabla con 60 segundos
    try {
      await page.waitForSelector("#MainContent_GVHistorial", { 
        state: "visible", 
        timeout: 60000 
      });
      console.log("✅ Tabla de recibos cargada");
      
      // Scroll para asegurar que todo cargue
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);
      
    } catch (error) {
      // Si no hay tabla, buscar mensaje de error
      const errorMessage = await page.locator([
        ".validation-summary-errors",
        ".field-validation-error",
        "[id*='lblMensaje']",
        "[class*='error']",
        "[class*='alert']"
      ].join(",")).textContent().catch(() => null);
      
      if (errorMessage && errorMessage.trim()) {
        console.log(`❌ CFE mostró error: ${errorMessage.trim()}`);
        throw new Error(`CFE dice: ${errorMessage.trim()}`);
      }
      
      // Verificar si la página tiene algún contenido
      const bodyText = await page.textContent("body");
      if (bodyText && bodyText.includes("No se encontraron")) {
        throw new Error("No se encontraron recibos para los datos proporcionados.");
      }
      
      // Verificar si hay un CAPTCHA
      const hasCaptcha = await page.locator([
        "iframe[src*='captcha']",
        "iframe[src*='recaptcha']",
        ".g-recaptcha"
      ].join(",")).count();
      
      if (hasCaptcha > 0) {
        throw new Error("CFE solicitó verificación humana (CAPTCHA). No se puede automatizar.");
      }
      
      throw new Error("No se pudo cargar la tabla de resultados. Verifica los datos.");
    }

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

    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `attachment; filename="recibo-${parsed.data.numeroServicio}.pdf"`);
    response.setHeader("Cache-Control", "no-store, max-age=0");
    return response.status(200).send(pdfBuffer);

  } catch (error) {
    console.error("❌ Error:", error.message);
    if (browser) await browser.close().catch(() => {});
    if (!response.headersSent) {
      return response.status(500).json({
        error: error.message || "No fue posible obtener el recibo. Verifica los datos.",
      });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("=".repeat(60));
  console.log(`✅ Servidor activo en el puerto ${PORT}`);
  console.log(`🔑 Proxy: Decodo (${PROXY_CONFIG.server})`);
  console.log("=".repeat(60));
});
