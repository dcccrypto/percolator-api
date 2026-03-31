import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read the OpenAPI spec once at startup to avoid blocking the event loop on
// each request and to cache the result for the lifetime of the process.
let cachedOpenApiYaml: string | null = null;
async function loadOpenApiYaml(): Promise<string> {
  if (cachedOpenApiYaml) return cachedOpenApiYaml;
  const openapiPath = join(__dirname, "..", "..", "openapi.yaml");
  cachedOpenApiYaml = await readFile(openapiPath, "utf-8");
  return cachedOpenApiYaml;
}

export function docsRoutes(): Hono {
  const app = new Hono();

  // Serve Swagger UI at /docs
  // Hash of the inline init script — override the global CSP to allow it without 'unsafe-inline'
  const INIT_SCRIPT_HASH = "sha256-D1qu74KZvpXsEKUAyhuFNctjeQq+07qFNQHj4fSjFqQ=";

  app.get("/docs", (c) => {
    c.header("Content-Security-Policy", `script-src 'self' unpkg.com '${INIT_SCRIPT_HASH}'; style-src 'self' unpkg.com 'unsafe-inline'`);
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Percolator API Documentation</title>
  <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@5.10.5/swagger-ui.css" integrity="sha384-fggJG3d/1uo8FjBTP7/QTfjIzaMS1AWDUnQarNCJZzqQlqjGLP0Kx8Un9XXsiv2q" crossorigin="anonymous">
  <style>
    html { box-sizing: border-box; overflow: -moz-scrollbars-vertical; overflow-y: scroll; }
    *, *:before, *:after { box-sizing: inherit; }
    body { margin: 0; padding: 0; }
    .topbar { display: none !important; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.10.5/swagger-ui-bundle.js" integrity="sha384-scCk4H/owymn3wdPNx4OQh/3JuTclN1cRMh0Rbj4htBKPImeXEghC5zPAFLZnTts" crossorigin="anonymous"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5.10.5/swagger-ui-standalone-preset.js" integrity="sha384-azzkurII4f+bjmZvm3hWhj7JezshyXtwobwneRyWCCIksK61Xi0Ry3xA2am9/TWp" crossorigin="anonymous"></script>
  <script>
    window.onload = function() {
      window.ui = SwaggerUIBundle({
        url: '/docs/openapi.yaml',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        plugins: [
          SwaggerUIBundle.plugins.DownloadUrl
        ],
        layout: "StandaloneLayout",
        defaultModelsExpandDepth: 1,
        defaultModelExpandDepth: 1,
        docExpansion: "list",
        filter: true,
        showRequestHeaders: true,
        tryItOutEnabled: true
      });
    };
  </script>
</body>
</html>`;
    
    return c.html(html);
  });

  // Serve the OpenAPI YAML spec
  app.get("/docs/openapi.yaml", async (c) => {
    try {
      const yaml = await loadOpenApiYaml();
      c.header("Content-Type", "text/yaml");
      return c.body(yaml);
    } catch (err) {
      return c.json({ error: "Failed to load OpenAPI specification" }, 500);
    }
  });

  return app;
}
