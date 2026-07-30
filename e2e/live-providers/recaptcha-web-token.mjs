import { open } from "node:fs/promises";
import { createServer } from "node:http";

const siteKey = process.env.RECAPTCHA_ENTERPRISE_WEB_SITE_KEY;
const action = process.env.RECAPTCHA_ENTERPRISE_ACTION ?? "LOGIN";
const output =
  process.env.RECAPTCHA_ENTERPRISE_WEB_TOKEN_FILE ?? "/tmp/omni-recaptcha-enterprise-web-token";
const port = Number(process.env.RECAPTCHA_ENTERPRISE_WEB_TOKEN_PORT ?? "8791");

if (siteKey === undefined || !/^[A-Za-z0-9_-]{20,}$/.test(siteKey)) {
  throw new Error("Set RECAPTCHA_ENTERPRISE_WEB_SITE_KEY to the web key under test");
}
if (!/^[A-Za-z][A-Za-z0-9_/-]{0,99}$/.test(action)) {
  throw new Error("RECAPTCHA_ENTERPRISE_ACTION has an invalid action name");
}
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("RECAPTCHA_ENTERPRISE_WEB_TOKEN_PORT must be a valid TCP port");
}

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>omni-model reCAPTCHA Enterprise E2E</title>
    <script src="https://www.google.com/recaptcha/enterprise.js?render=${encodeURIComponent(siteKey)}"></script>
    <style>
      body { font: 16px system-ui; max-width: 42rem; margin: 4rem auto; padding: 0 1rem; }
      button { font: inherit; padding: .65rem 1rem; }
      #status { margin-top: 1rem; }
    </style>
  </head>
  <body>
    <h1>reCAPTCHA Enterprise E2E</h1>
    <p>This page sends one short-lived token directly to the local test handoff.</p>
    <button id="run" type="button">Generate fresh token</button>
    <p id="status" role="status">Ready.</p>
    <script>
      const siteKey = ${JSON.stringify(siteKey)};
      const action = ${JSON.stringify(action)};
      const status = document.querySelector("#status");
      const run = async () => {
        status.textContent = "Generating token…";
        try {
          await new Promise((resolve) => grecaptcha.enterprise.ready(resolve));
          const token = await grecaptcha.enterprise.execute(siteKey, { action });
          const response = await fetch("/token", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token }),
          });
          if (!response.ok) throw new Error("local handoff rejected the token");
          status.textContent = "Fresh token received. Run the E2E test now.";
        } catch (error) {
          status.textContent = "Token generation failed: " + String(error);
        }
      };
      document.querySelector("#run").addEventListener("click", run);
      run();
    </script>
  </body>
</html>`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(page);
    return;
  }
  if (request.method === "POST" && url.pathname === "/token") {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 16_384) {
        response.writeHead(413);
        response.end();
        return;
      }
      chunks.push(chunk);
    }
    let token;
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      token = typeof body.token === "string" ? body.token : undefined;
    } catch {
      token = undefined;
    }
    if (token === undefined || token.length < 20 || token.length > 16_000) {
      response.writeHead(400);
      response.end();
      return;
    }
    const tokenFile = await open(output, "w", 0o600);
    try {
      await tokenFile.chmod(0o600);
      await tokenFile.writeFile(`${token}\n`);
    } finally {
      await tokenFile.close();
    }
    response.writeHead(204, { "cache-control": "no-store" });
    response.end(() => {
      console.log(`Fresh token saved with mode 0600 at ${output}.`);
      server.close();
    });
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Open http://localhost:${port}/ to generate a fresh ${action} token.`);
  console.log("The token is never printed and the handoff server exits after receiving it.");
});
