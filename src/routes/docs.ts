import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function docsRoutes(): Hono {
  const app = new Hono();

  // Serve Swagger UI at /docs
  app.get("/docs", (c) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Percolator API Documentation</title>
  <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@5.10.5/swagger-ui.css">
  <style>
    html { box-sizing: border-box; overflow: -moz-scrollbars-vertical; overflow-y: scroll; }
    *, *:before, *:after { box-sizing: inherit; }
    body { margin: 0; padding: 0; }
    .topbar { display: none !important; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.10.5/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5.10.5/swagger-ui-standalone-preset.js"></script>
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
  app.get("/docs/openapi.yaml", (c) => {
    try {
      // Read the openapi.yaml file from the package root
      const openapiPath = join(__dirname, "..", "..", "openapi.yaml");
      const yaml = readFileSync(openapiPath, "utf-8");
      
      c.header("Content-Type", "text/yaml");
      return c.body(yaml);
    } catch (err) {
      return c.json({ error: "Failed to load OpenAPI specification" }, 500);
    }
  });

  return app;
}
