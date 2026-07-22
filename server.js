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
const PROXY_PORTS = [10001, 10002, 10003, 10004];
let currentPortIndex = 0;

function getProxyConfig() {
  const port = PROXY_PORTS[currentPortIndex % PROXY_PORTS.length];
  currentPortIndex++;
  return {
    server: `http://gate.decodo.com:${port}`,
    username: 'spp9625kp7',
    password: 'w3rn85=sdkit1JSjIP'  // ← Cambia por tu contraseña real
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
// TEST DE PROXY
// ============================================================
app.get("/proxy-test", async (req, res) => {
  let browser;
  try {
    const config = getProxyConfig();
    console.log("🔄 Probando proxy:", config.server);
    
    browser = await chromium.launch({
      headless: true,
      proxy: config,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    
    const page = await browser.newPage();
    await page.goto('https://api.ipify.org?format=json');
    const content = await page.textContent('body');
    await browser.close();
    
    res.json({
      ok: true,
      ip: JSON.parse(content).ip,
      proxy: config.server,
      mensaje: "✅ Proxy funcionando"
    });
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    res.json({ ok: false, error: error.message });
  }
});

// ============================================================
// FUNCIÓN PARA LLENAR CAMPOS CON SEGURIDAD
// ============================================================
async function safeFill(page, selector, value, timeout = 10000) {
  try {
    // Esperar a que el campo exista y sea visible
    await page.waitForSelector(selector, { state: 'visible', timeout });
    
    // Verificar que el campo está habilitado
    const isDisabled = await page.locator(selector).getAttribute('disabled');
    if (isDisabled) {
      console.log(`⚠️ Campo ${selector} está deshabilitado, omitiendo`);
      return false;
    }
    
    // Limpiar y llenar
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
// ENDPOINT PRINCIPAL
// ============================================================
app.post("/obtener-recibo", async (request, response) => {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: "Datos inválidos." });
  }

  let browser;
  let proxyConfig;

  try {
    const maxAttempts = PROXY_PORTS.length;
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      proxyConfig = getProxyConfig();
      console.log(`🔄 Intento ${attempt + 1} con proxy: ${proxyConfig.server}`);
      
      try {
        browser = await chromium.launch({
          headless: true,
          proxy: proxyConfig,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled"
          ],
        });

        const context = await browser.newContext({
          acceptDownloads: true,
          locale: "es-MX",
          viewport: { width: 1920, height: 1080 },
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });

        const page = await context.newPage();
        page.setDefaultTimeout(60000);

        // ============================================================
        // 1. IR A CFE
        // ============================================================
        console.log("🌐 Navegando a CFE...");
        const navigationResponse = await page.goto(CFE_URL, {
          waitUntil: "networkidle",  // ← Cambiado a networkidle
          timeout: 60000,
        });

        const statusCode = navigationResponse?.status() ?? 0;
        console.log(`CFE STATUS: ${statusCode}`);

        if (statusCode >= 400) {
          throw new Error(`CFE respondió con estado ${statusCode}`);
        }

        const pageTitle = await page.title();
        console.log(`CFE TITLE: ${pageTitle}`);

        // ============================================================
        // 2. VERIFICAR QUE EL FORMULARIO EXISTA
        // ============================================================
        const nombreField = page.locator("#MainContent_txtNombre");
        const nombreCount = await nombreField.count();
        console.log(`CAMPO NOMBRE ENCONTRADO: ${nombreCount}`);

        if (nombreCount === 0) {
          throw new Error("El formulario de CFE no apareció.");
        }

        // Esperar un momento para que la página se estabilice
        await page.waitForTimeout(2000);

        // ============================================================
        // 3. LLENAR FORMULARIO
        // ============================================================
        console.log("📝 Llenando formulario...");

        // Intentar llenar cada campo
        await safeFill(page, "#MainContent_txtNombre", parsed.data.nombreCompleto);
        await safeFill(page, "#MainContent_txtRPU", parsed.data.numeroServicio);
        await safeFill(page, "#MainContent_tbLada", parsed.data.lada);
        await safeFill(page, "#MainContent_txtTel", parsed.data.telefonoFijo);
        await safeFill(page, "#MainContent_txtCel", parsed.data.celular);
        await safeFill(page, "#MainContent_txtCorreoElectronico", parsed.data.correo);

        // ============================================================
        // 4. DETECTAR CAPTCHA
        // ============================================================
        const captchaCount = await page.locator([
          "iframe[src*='captcha']", "iframe[src*='recaptcha']", ".g-recaptcha",
          "[id*='captcha' i]", "[class*='captcha' i]"
        ].join(",")).count();

        if (captchaCount > 0) {
          return response.status(409).json({ error: "Verificación humana solicitada." });
        }

        // ============================================================
        // 5. ENVIAR FORMULARIO
        // ============================================================
        console.log("🔄 Enviando formulario...");
        
        await Promise.all([
          page.waitForLoadState("networkidle").catch(() => null),
          page.locator("#MainContent_btnContinuar").click(),
        ]);

        // ============================================================
        // 6. ESPERAR RESULTADOS
        // ============================================================
        console.log("⏳ Esperando resultados...");
        
        const pdfSelector = 'input[id^="MainContent_GVHistorial_DescargaPDF_"]';
        
        try {
          await page.locator(pdfSelector).first().waitFor({ 
            state: "visible", 
            timeout: 60000 
          });
          console.log("✅ Resultados cargados");
        } catch (error) {
          console.log("❌ No se encontraron resultados");
          
          // Verificar si hay mensaje de error
          const errorMessage = await page.locator([
            ".validation-summary-errors",
            ".field-validation-error",
            "[id*='lblMensaje']",
            "[class*='error']"
          ].join(",")).textContent().catch(() => null);
          
          if (errorMessage && errorMessage.trim()) {
            return response.status(404).json({ 
              error: errorMessage.trim() 
            });
          }
          
          throw new Error("No se encontraron recibos para los datos proporcionados.");
        }

        // ============================================================
        // 7. DESCARGAR PDF
        // ============================================================
        console.log("📄 Descargando PDF...");
        
        const downloadPromise = page.waitForEvent("download", { timeout: 60000 });
        await page.locator(pdfSelector).first().click();
        const download = await downloadPromise;
        const downloadPath = await download.path();

        if (!downloadPath) throw new Error("No se generó el archivo.");

        const pdfBuffer = await fs.readFile(downloadPath);
        
        // Verificar que es PDF válido
        if (pdfBuffer.length < 4 || pdfBuffer.subarray(0, 4).toString() !== "%PDF") {
          throw new Error("El archivo no es un PDF válido.");
        }

        await browser.close();
        console.log(`✅ PDF obtenido correctamente (${pdfBuffer.length} bytes)`);

        // Devolver PDF
        response.setHeader("Content-Type", "application/pdf");
        response.setHeader("Content-Disposition", `attachment; filename="recibo-${parsed.data.numeroServicio}.pdf"`);
        response.setHeader("Cache-Control", "no-store, max-age=0");
        return response.status(200).send(pdfBuffer);

      } catch (error) {
        console.error(`❌ Error con proxy ${proxyConfig.server}:`, error.message);
        lastError = error;
        if (browser) {
          await browser.close().catch(() => {});
          browser = null;
        }
        continue;
      }
    }

    throw new Error(`Todos los proxies fallaron. Último error: ${lastError?.message || 'Desconocido'}`);

  } catch (error) {
    console.error("Error final:", error);
    if (browser) await browser.close().catch(() => {});
    if (!response.headersSent) {
      return response.status(500).json({
        error: "No fue posible obtener el recibo. Verifica los datos e inténtalo nuevamente.",
      });
    }
  }
});

// ============================================================
// INICIO
// ============================================================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor activo en el puerto ${PORT}`);
});
