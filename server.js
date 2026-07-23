import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { z } from "zod";
import fs from "node:fs/promises";
import axios from "axios";

const app = express();
const PORT = process.env.PORT || 3001;
const CFE_URL = "https://app.cfe.mx/Aplicaciones/CCFE/ReciboDeLuzGMX/Consulta";

// ============================================================
// CONFIGURACIÓN - DECODO
// ============================================================
const PROXY_CONFIG = {
  server: 'http://mx.decodo.com:20001',
  username: 'spp9625kp7',
  password: 'w3rn85=sdkit1JSjIP',
};

// ============================================================
// CONFIGURACIÓN - ANTI-CAPTCHA
// ============================================================
const ANTICAPTCHA_KEY = "d176bfc7a9fc3028cfbec2276cf741f1";

// ============================================================
// FUNCIÓN PARA RESOLVER CAPTCHA CON ANTI-CAPTCHA
// ============================================================
async function resolverCaptchaConAntiCaptcha(imageBase64) {
  try {
    console.log("🔄 Enviando CAPTCHA a Anti-Captcha...");
    
    const createTaskResponse = await axios.post('https://api.anti-captcha.com/createTask', {
      clientKey: ANTICAPTCHA_KEY,
      task: {
        type: "ImageToTextTask",
        body: imageBase64,
        numeric: 1,
        minLength: 4,
        maxLength: 6
      }
    });
    
    if (createTaskResponse.data.errorId !== 0) {
      throw new Error(`Error Anti-Captcha: ${createTaskResponse.data.errorDescription}`);
    }
    
    const taskId = createTaskResponse.data.taskId;
    console.log(`📝 Task ID: ${taskId}, esperando resolución...`);
    
    let attempts = 0;
    const maxAttempts = 30;
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      attempts++;
      
      const getResultResponse = await axios.post('https://api.anti-captcha.com/getTaskResult', {
        clientKey: ANTICAPTCHA_KEY,
        taskId: taskId
      });
      
      if (getResultResponse.data.errorId !== 0) {
        throw new Error(`Error: ${getResultResponse.data.errorDescription}`);
      }
      
      if (getResultResponse.data.status === 'ready') {
        console.log(`✅ CAPTCHA resuelto: ${getResultResponse.data.solution.text}`);
        return getResultResponse.data.solution.text;
      }
      
      console.log(`⏳ Intentando (${attempts}/${maxAttempts})...`);
    }
    
    throw new Error("⏰ Timeout resolviendo CAPTCHA");
    
  } catch (error) {
    console.error("❌ Error resolviendo CAPTCHA:", error.message);
    throw error;
  }
}

// ============================================================
// FUNCIÓN PARA RESOLVER CAPTCHA EN PLAYWRIGHT
// ============================================================
async function resolverCaptcha(page) {
  try {
    console.log("🔍 Esperando CAPTCHA...");
    
    // Esperar a que el modal aparezca (hasta 30 segundos)
    await page.waitForSelector('.modal, .modal-content, [class*="modal"]', { 
      timeout: 30000 
    });
    console.log("✅ Modal de CAPTCHA encontrado");
    
    // Esperar un momento para que cargue la imagen
    await page.waitForTimeout(2000);
    
    // Tomar captura del CAPTCHA
    const captchaImage = await page.locator('#MainContent_Imagemanual, #MainContent_ImagenManual, img[src*="data:image/png;base64"]').first().screenshot({ encoding: "base64" });
    
    const solution = await resolverCaptchaConAntiCaptcha(captchaImage);
    
    // Llenar el campo del CAPTCHA
    await page.fill('#MainContent_txtCaptcha, input[type="text"][maxlength="10"]', solution);
    console.log(`✅ CAPTCHA llenado con: ${solution}`);
    
    // Hacer clic en "Aceptar"
    await page.click('#MainContent_btnAceptar, input[value="Aceptar"], button:has-text("Aceptar")');
    console.log("✅ Botón Aceptar presionado");
    
    // Esperar a que el modal se cierre
    await page.waitForTimeout(3000);
    console.log("✅ Modal cerrado");
    
    return solution;
  } catch (error) {
    console.error("❌ Error en resolución:", error.message);
    throw error;
  }
}

// ============================================================
// MIDDLEWARE
// ============================================================
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
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
    });
    const page = await browser.newPage();
    await page.goto("https://api.ipify.org?format=json", { timeout: 30000 });
    const content = await page.textContent("body");
    await browser.close();
    res.json({ ok: true, ip: JSON.parse(content).ip, mensaje: "✅ Proxy funcionando" });
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
    page.setDefaultTimeout(120000);

    console.log("🌐 Navegando a CFE...");
    await page.goto(CFE_URL, { waitUntil: "networkidle", timeout: 60000 });

    const nombreCount = await page.locator("#MainContent_txtNombre").count();
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
    await page.click("#MainContent_btnContinuar");

    console.log("⏳ Esperando resultados...");

    // ============================================================
    // DETECTAR CAPTCHA EN MODAL DESPUÉS DEL ENVÍO
    // ============================================================
    await page.waitForTimeout(5000); // Esperar 5 segundos para que cargue
    
    // Verificar si hay un modal visible
    const modalCount = await page.locator('.modal, .modal-content, [class*="modal"]').count();
    console.log(`📊 Modales encontrados: ${modalCount}`);
    
    if (modalCount > 0) {
      console.log("🔍 CAPTCHA en modal detectado, resolviendo...");
      await resolverCaptcha(page);
      console.log("✅ CAPTCHA resuelto");
    } else {
      console.log("ℹ️ No se detectó CAPTCHA, continuando...");
    }

    // ============================================================
    // ESPERAR EL BOTÓN DE DESCARGA
    // ============================================================
    try {
      await page.waitForSelector('input[title="Descarga Pdf"]', { 
        timeout: 60000 
      });
      console.log("✅ Botón de descarga encontrado");
    } catch (error) {
      // Verificar si hay otro CAPTCHA
      const modalCount2 = await page.locator('.modal, .modal-content, [class*="modal"]').count();
      if (modalCount2 > 0) {
        console.log("🔍 CAPTCHA en modal detectado, resolviendo...");
        await resolverCaptcha(page);
        await page.waitForSelector('input[title="Descarga Pdf"]', { timeout: 30000 });
        console.log("✅ Botón de descarga encontrado después del CAPTCHA");
      } else {
        const bodyText = await page.textContent("body");
        if (bodyText && bodyText.includes("No se encontraron")) {
          throw new Error("No se encontraron recibos para los datos proporcionados.");
        }
        throw new Error("No se encontró el botón de descarga. Verifica los datos.");
      }
    }

    // ============================================================
    // DESCARGAR PDF
    // ============================================================
    console.log("📄 Descargando PDF...");
    const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
    await page.click('input[title="Descarga Pdf"]');
    const download = await downloadPromise;
    const pdfPath = await download.path();
    const pdfBuffer = await fs.readFile(pdfPath);
    
    await browser.close();
    console.log(`✅ PDF obtenido (${pdfBuffer.length} bytes)`);
    
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `attachment; filename="recibo-${parsed.data.numeroServicio}.pdf"`);
    return response.send(pdfBuffer);

  } catch (error) {
    console.error("❌ Error:", error.message);
    if (browser) await browser.close().catch(() => {});
    if (!response.headersSent) {
      return response.status(500).json({
        error: error.message || "No fue posible obtener el recibo.",
      });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("=".repeat(60));
  console.log(`✅ Servidor activo en el puerto ${PORT}`);
  console.log(`🔑 Proxy: Decodo (${PROXY_CONFIG.server})`);
  console.log(`🔐 Anti-Captcha: ✅ Configurado`);
  console.log("=".repeat(60));
});
