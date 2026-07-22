import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { z } from "zod";
import fs from "node:fs/promises";

const app = express();
const PORT = process.env.PORT || 3000;
const CFE_URL = "https://app.cfe.mx/Aplicaciones/CCFE/ReciboDeLuzGMX/Consulta";

// ============================================================
// CONFIGURACIÓN - DECODO (PRUEBA CON DIFERENTES PUERTOS)
// ============================================================
const PROXY_PORTS = [10001, 10002, 10003, 10004];
let currentPortIndex = 0;

function getProxyConfig() {
  const port = PROXY_PORTS[currentPortIndex % PROXY_PORTS.length];
  currentPortIndex++;
  return {
    server: `http://gate.decodo.com:${port}`,
    username: 'spp9625kp7',
    password: 'w3rn85=sdkit1JSjIP'  // ← Verifica tu contraseña exacta
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
    // Intentar con varios puertos hasta que uno funcione
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

        // Navegar a CFE
        const navigationResponse = await page.goto(CFE_URL, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });

        const statusCode = navigationResponse?.status() ?? 0;
        const finalUrl = page.url();
        const pageTitle = await page.title();

        console.log(`CFE STATUS: ${statusCode}`);
        console.log(`CFE URL FINAL: ${finalUrl}`);
        console.log(`CFE TITLE: ${pageTitle}`);

        if (statusCode >= 400) {
          throw new Error(`CFE respondió con estado ${statusCode}. URL: ${finalUrl}`);
        }

        const nombreField = page.locator("#MainContent_txtNombre");
        const nombreCount = await nombreField.count();
        console.log(`CAMPO NOMBRE ENCONTRADO: ${nombreCount}`);

        if (nombreCount === 0) {
          throw new Error(`El formulario de CFE no apareció. Título: ${pageTitle}. URL: ${finalUrl}`);
        }

        // Esperar y llenar
        await page.waitForTimeout(1000 + Math.random() * 2000);
        await nombreField.waitFor({ state: "visible", timeout: 30000 });
        await nombreField.fill(parsed.data.nombreCompleto);

        await page.locator("#MainContent_txtRPU").fill(parsed.data.numeroServicio);
        await page.locator("#MainContent_tbLada").fill(parsed.data.lada);
        await page.locator("#MainContent_txtTel").fill(parsed.data.telefonoFijo);
        await page.locator("#MainContent_txtCel").fill(parsed.data.celular);
        await page.locator("#MainContent_txtCorreoElectronico").fill(parsed.data.correo);

        // Detectar captcha
        const captchaCount = await page.locator([
          "iframe[src*='captcha']", "iframe[src*='recaptcha']", ".g-recaptcha",
          "[id*='captcha' i]", "[class*='captcha' i]"
        ].join(",")).count();

        if (captchaCount > 0) {
          return response.status(409).json({ error: "Verificación humana solicitada." });
        }

        // Enviar formulario
        await Promise.all([
          page.waitForLoadState("domcontentloaded").catch(() => null),
          page.locator("#MainContent_btnContinuar").click(),
        ]);

        // Esperar resultados
        const pdfSelector = 'input[id^="MainContent_GVHistorial_DescargaPDF_"]';
        await page.locator(pdfSelector).first().waitFor({ state: "visible", timeout: 60000 });

        // Descargar PDF
        const downloadPromise = page.waitForEvent("download", { timeout: 60000 });
        await page.locator(pdfSelector).first().click();
        const download = await downloadPromise;
        const downloadPath = await download.path();

        if (!downloadPath) throw new Error("No se generó el archivo.");

        const pdfBuffer = await fs.readFile(downloadPath);
        if (pdfBuffer.length < 4 || pdfBuffer.subarray(0, 4).toString() !== "%PDF") {
          throw new Error("El archivo no es un PDF válido.");
        }

        await browser.close();
        console.log("✅ PDF obtenido correctamente");

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
        // Continuar con el siguiente puerto
        continue;
      }
    }

    // Si llegamos aquí, todos los puertos fallaron
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
