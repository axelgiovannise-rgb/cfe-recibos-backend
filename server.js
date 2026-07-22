import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { z } from "zod";
import fs from "node:fs/promises";

const app = express();

const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGIN =
  process.env.ALLOWED_ORIGIN || "*";

const CFE_URL =
  "https://app.cfe.mx/Aplicaciones/CCFE/ReciboDeLuzGMX/Consulta";

app.use(
  cors({
    origin:
      ALLOWED_ORIGIN === "*"
        ? true
        : ALLOWED_ORIGIN,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  }),
);

app.use(
  express.json({
    limit: "20kb",
  }),
);

const schema = z.object({
  nombreCompleto: z
    .string()
    .trim()
    .min(3)
    .max(120),

  numeroServicio: z
    .string()
    .trim()
    .min(1)
    .max(24)
    .regex(/^\d+$/),

  lada: z
    .string()
    .trim()
    .min(2)
    .max(5)
    .regex(/^\d+$/),

  telefonoFijo: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^\d+$/),

  celular: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^\d+$/),

  correo: z
    .string()
    .trim()
    .email()
    .max(255),
});

app.get("/", (_request, response) => {
  response.json({
    ok: true,
    servicio: "Backend de recibos activo",
  });
});

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
  });
});

app.post(
  "/obtener-recibo",
  async (request, response) => {
    const parsed = schema.safeParse(
      request.body,
    );

    if (!parsed.success) {
      return response.status(400).json({
        error:
          "Los datos proporcionados no son válidos.",
      });
    }

    let browser;

    try {
      browser = await chromium.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      });

      const context =
        await browser.newContext({
          acceptDownloads: true,
          locale: "es-MX",
        });

      const page = await context.newPage();

      page.setDefaultTimeout(60000);

      await page.goto(CFE_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      await page
        .locator("#MainContent_txtNombre")
        .waitFor({
          state: "visible",
        });

      await page
        .locator("#MainContent_txtNombre")
        .fill(
          parsed.data.nombreCompleto,
        );

      await page
        .locator("#MainContent_txtRPU")
        .fill(
          parsed.data.numeroServicio,
        );

      await page
        .locator("#MainContent_tbLada")
        .fill(parsed.data.lada);

      await page
        .locator("#MainContent_txtTel")
        .fill(
          parsed.data.telefonoFijo,
        );

      await page
        .locator("#MainContent_txtCel")
        .fill(parsed.data.celular);

      await page
        .locator(
          "#MainContent_txtCorreoElectronico",
        )
        .fill(parsed.data.correo);

      const captchaCount =
        await page
          .locator(
            [
              "iframe[src*='captcha']",
              "iframe[src*='recaptcha']",
              ".g-recaptcha",
              "[id*='captcha' i]",
              "[class*='captcha' i]",
            ].join(","),
          )
          .count();

      if (captchaCount > 0) {
        return response.status(409).json({
          error:
            "El portal solicitó una verificación humana. La consulta no puede completarse automáticamente.",
        });
      }

      await Promise.all([
        page.waitForLoadState(
          "domcontentloaded",
        ).catch(() => null),

        page
          .locator(
            "#MainContent_btnContinuar",
          )
          .click(),
      ]);

      const validationMessage =
        await page
          .locator(
            [
              ".validation-summary-errors",
              ".field-validation-error",
              "[id*='lblMensaje' i]",
              "[id*='mensaje' i]",
              "[class*='error' i]",
            ].join(","),
          )
          .allTextContents()
          .catch(() => []);

      const visibleError =
        validationMessage
          .map((text) => text.trim())
          .filter(Boolean)
          .join(" ");

      const pdfSelector =
        'input[id^="MainContent_GVHistorial_DescargaPDF_"]';

      try {
        await page
          .locator(pdfSelector)
          .first()
          .waitFor({
            state: "visible",
            timeout: 60000,
          });
      } catch {
        const captchaAfterSubmit =
          await page
            .locator(
              [
                "iframe[src*='captcha']",
                "iframe[src*='recaptcha']",
                ".g-recaptcha",
                "[id*='captcha' i]",
                "[class*='captcha' i]",
              ].join(","),
            )
            .count();

        if (captchaAfterSubmit > 0) {
          return response
            .status(409)
            .json({
              error:
                "El portal solicitó una verificación humana.",
            });
        }

        return response
          .status(404)
          .json({
            error:
              visibleError ||
              "No se encontró un recibo con los datos proporcionados.",
          });
      }

      const downloadPromise =
        page.waitForEvent("download", {
          timeout: 60000,
        });

      await page
        .locator(pdfSelector)
        .first()
        .click();

      const download =
        await downloadPromise;

      const downloadPath =
        await download.path();

      if (!downloadPath) {
        throw new Error(
          "El portal no generó el archivo.",
        );
      }

      const pdfBuffer =
        await fs.readFile(downloadPath);

      if (
        pdfBuffer.length < 4 ||
        pdfBuffer
          .subarray(0, 4)
          .toString() !== "%PDF"
      ) {
        throw new Error(
          "El archivo recibido no es un PDF válido.",
        );
      }

      const safeServiceNumber =
        parsed.data.numeroServicio.replace(
          /\D/g,
          "",
        );

      response.setHeader(
        "Content-Type",
        "application/pdf",
      );

      response.setHeader(
        "Content-Disposition",
        `attachment; filename="recibo-${safeServiceNumber}.pdf"`,
      );

      response.setHeader(
        "Cache-Control",
        "no-store, max-age=0",
      );

      return response.status(200).send(
        pdfBuffer,
      );
    } catch (error) {
      console.error(
        "Error obteniendo recibo:",
        error,
      );

      if (!response.headersSent) {
        return response
          .status(500)
          .json({
            error:
              "No fue posible obtener el recibo. Verifica los datos e inténtalo nuevamente.",
          });
      }
    } finally {
      if (browser) {
        await browser
          .close()
          .catch(() => null);
      }
    }
  },
);

app.use(
  (
    error,
    _request,
    response,
    _next,
  ) => {
    console.error(
      "Error del servidor:",
      error,
    );

    response.status(500).json({
      error:
        "Ocurrió un error interno.",
    });
  },
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Servidor activo en el puerto ${PORT}`,
  );
});
