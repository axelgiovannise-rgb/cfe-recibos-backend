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
const PROXY_USERNAME = "spp9625kp7";
const PROXY_PASSWORD = "w3rn85=sdkit1JSjIP";
const PROXY_SERVER = "gate.decodo.com";
const PROXY_PORTS = [10001, 10002, 10003, 10004, 10005, 10006, 10007];
let currentPortIndex = 0;

function getProxyConfig() {
  const port = PROXY_PORTS[currentPortIndex % PROXY_PORTS.length];
  currentPortIndex++;
  return {
    server: `http://${PROXY_SERVER}:${port}`,
    username: PROXY_USERNAME,
    password: PROXY_PASSWORD,
  };
}

// ============================================================
// CONFIGURACIÓN - ANTI-CAPTCHA
// ============================================================
const ANTICAPTCHA_KEY = "d176bfc7a9fc3028cfbec2276cf741f1";

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors({ origin: true, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type"] }));
app.options('*', cors());
app.use(express.json({ limit: "20kb" }));

// ============================================================
// ESQUEMA DE VALIDACIÓN
// ============================================================
const schema = z.object({
  nombreCompleto: z.string().trim().min(3).max(120),
  numeroServicio: z.string().trim().min(1).max(24).regex(/^\d+$/),
  lada: z.string().trim().min(2).max(5).regex(/^\d+$/).default("55"),
  telefonoFijo: z.string().trim().min(1).max(20).regex(/^\d+$/).optional(),
  celular: z.string().trim().min(1).max(20).regex(/^\d+$/).optional(),
  correo: z.string().trim().email().max(255).optional(),
});

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
async function resolverCaptcha(page, contexto = "general") {
  try {
    console.log(`🔍 Esperando CAPTCHA (${contexto})...`);
    
    await page.waitForSelector('#myModalRevisarNumero', { 
      timeout: 15000 
    });
    console.log(`✅ Modal de CAPTCHA encontrado (${contexto})`);
    
    await page.waitForTimeout(1000);
    
    const captchaImage = await page.locator('#MainContent_Imagemanual').screenshot({ encoding: "base64" });
    
    const solution = await resolverCaptchaConAntiCaptcha(captchaImage);
    
    await page.fill('#MainContent_txtCaptcha', solution);
    console.log(`✅ CAPTCHA llenado con: ${solution} (${contexto})`);
    
    await page.click('#MainContent_btnAceptar');
    console.log(`✅ Botón Aceptar presionado (${contexto})`);
    
    await page.waitForSelector('#myModalRevisarNumero', { state: 'hidden', timeout: 10000 });
    console.log(`✅ Modal cerrado (${contexto})`);
    
    return solution;
  } catch (error) {
    console.error(`❌ Error en resolución (${contexto}):`, error.message);
    throw error;
  }
}

// ============================================================
// ENDPOINTS
// ============================================================
app.get("/", (req, res) => res.json({ ok: true, servicio: "Backend de recibos activo" }));
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/proxy-test", async (req, res) => {
  let browser;
  try {
    const config = getProxyConfig();
    console.log(`🔄 Probando proxy: ${config.server}`);
    browser = await chromium.launch({
      headless: true,
      proxy: config,
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
    const element = page.locator(selector);
    const count = await element.count();
    if (count === 0) {
      console.log(`⚠️ Elemento ${selector} no encontrado, omitiendo...`);
      return false;
    }
    await element.waitFor({ state: "visible", timeout: 5000 });
    await element.clear();
    await element.fill(value);
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
  let proxyConfig;

  try {
    console.log("=".repeat(60));
    console.log("🚀 OBTENIENDO RECIBO");
    console.log("=".repeat(60));
    console.log(`👤 Usuario: ${parsed.data.nombreCompleto}`);
    console.log(`🔢 Servicio: ${parsed.data.numeroServicio}`);
    console.log("=".repeat(60));

    for (let intento = 0; intento < PROXY_PORTS.length; intento++) {
      proxyConfig = getProxyConfig();
      console.log(`🔄 Intento ${intento + 1} con proxy: ${proxyConfig.server}`);
      
      try {
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

        const nombre = parsed.data.nombreCompleto;
        const rpu = parsed.data.numeroServicio;
        const lada = parsed.data.lada || "55";
        const telefono = parsed.data.telefonoFijo || "55555555";
        const correo = parsed.data.correo || "test@test.com";

        await safeFill(page, "#MainContent_txtNombre", nombre);
        await safeFill(page, "#MainContent_txtRPU", rpu);
        await safeFill(page, "#MainContent_tbLada", lada);
        await safeFill(page, "#MainContent_txtTel", telefono);
        await safeFill(page, "#MainContent_txtCorreoElectronico", correo);

        if (parsed.data.celular) {
          await safeFill(page, "#MainContent_txtCel", parsed.data.celular);
        }

        console.log("🔄 Enviando formulario...");

        try {
          await page.click("#MainContent_btnContinuar", { force: true, timeout: 10000 });
          console.log("✅ Clic en Continuar ejecutado");
        } catch (error) {
          console.log("⚠️ Falló clic con force, intentando con evaluate...");
          await page.evaluate(() => {
            const btn = document.querySelector('#MainContent_btnContinuar');
            if (btn) btn.click();
          });
          console.log("✅ Clic en Continuar ejecutado con evaluate");
        }

        console.log("⏳ Esperando resultados...");

        let captchaResuelto = false;
        let botonEncontrado = false;

        // Esperar la tabla de recibos
        for (let i = 0; i < 30; i++) {
          await page.waitForTimeout(2000);
          
          const modalVisible = await page.locator('#myModalRevisarNumero').isVisible().catch(() => false);
          
          if (modalVisible) {
            console.log("🔍 CAPTCHA detectado, resolviendo...");
            await resolverCaptcha(page, "CAPTCHA");
            captchaResuelto = true;
            console.log("✅ CAPTCHA resuelto");
            break;
          }
          
          const hasDownloadBtn = await page.locator('#MainContent_GVHistorial_DescargaPDF_0').count();
          if (hasDownloadBtn > 0) {
            console.log("✅ ¡Botón de descarga encontrado!");
            botonEncontrado = true;
            break;
          }
          
          if (i % 5 === 0) {
            console.log(`⏳ Esperando... (${i+1}/30)`);
          }
        }

        if (!botonEncontrado) {
          const bodyText = await page.textContent("body");
          if (bodyText && bodyText.includes("No se encontraron")) {
            throw new Error("No se encontraron recibos para los datos proporcionados.");
          }
          throw new Error("No se encontró el botón de descarga.");
        }

        console.log("📄 Descargando PDF...");

        // ============================================================
        // HACER CLIC EN EL BOTÓN PDF
        // ============================================================
        console.log("🔄 Haciendo clic en el botón PDF...");
        await page.click('#MainContent_GVHistorial_DescargaPDF_0');
        console.log("✅ Clic en PDF ejecutado");

        // ============================================================
        // DETECTAR CAPTCHA DESPUÉS DEL CLIC EN PDF
        // ============================================================
        await page.waitForTimeout(3000);
        
        const captchaModal = await page.locator('#myModalRevisarNumero').isVisible().catch(() => false);
        
        if (captchaModal) {
          console.log("🔍 CAPTCHA detectado después del clic PDF, resolviendo...");
          await resolverCaptcha(page, "CAPTCHA PDF");
          console.log("✅ CAPTCHA resuelto");
        }

        // ============================================================
        // CAPTURAR EL PDF
        // ============================================================
        try {
          const pdfResponsePromise = page.waitForResponse(
            response => {
              const contentType = response.headers()['content-type'] || '';
              const url = response.url();
              return contentType.includes('pdf') || 
                     contentType.includes('application/pdf') ||
                     url.includes('.pdf') ||
                     url.includes('DescargaRecibo');
            },
            { timeout: 30000 }
          );

          const pdfResponse = await pdfResponsePromise;
          const pdfBuffer = await pdfResponse.body();
          
          if (pdfBuffer && pdfBuffer.length > 100) {
            console.log(`✅ PDF obtenido (${pdfBuffer.length} bytes)`);
            await browser.close();
            response.setHeader("Content-Type", "application/pdf");
            response.setHeader("Content-Disposition", `attachment; filename="recibo-${parsed.data.numeroServicio}.pdf"`);
            return response.send(pdfBuffer);
          }
        } catch (error) {
          console.log("⚠️ Falló la captura HTTP:", error.message);
          
          const html = await page.content();
          const pdfMatch = html.match(/https?:\/\/[^\s"']+\.pdf/);
          if (pdfMatch) {
            console.log(`📄 PDF URL encontrada: ${pdfMatch[0]}`);
            const pdfFetch = await fetch(pdfMatch[0]);
            const pdfBuffer = await pdfFetch.arrayBuffer();
            if (pdfBuffer && pdfBuffer.byteLength > 100) {
              console.log(`✅ PDF obtenido desde HTML (${pdfBuffer.byteLength} bytes)`);
              await browser.close();
              response.setHeader("Content-Type", "application/pdf");
              response.setHeader("Content-Disposition", `attachment; filename="recibo-${parsed.data.numeroServicio}.pdf"`);
              return response.send(Buffer.from(pdfBuffer));
            }
          }
        }

        throw new Error("No se pudo obtener el PDF");

      } catch (error) {
        console.error(`❌ Error con proxy ${proxyConfig.server}:`, error.message);
        if (browser) await browser.close().catch(() => {});
        browser = null;
        continue;
      }
    }

    throw new Error("Todos los proxies fallaron");

  } catch (error) {
    console.error("❌ Error final:", error.message);
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
  console.log(`🔑 Proxy: Decodo (rotación de ${PROXY_PORTS.length} puertos)`);
  console.log(`🔐 Anti-Captcha: ✅ Configurado`);
  console.log("=".repeat(60));
});
