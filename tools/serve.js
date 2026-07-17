"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 8000);
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".glsl", "text/plain; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".wasm", "application/wasm"],
]);

const server = http.createServer((request, response) => {
  let pathname;

  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch (error) {
    send(response, 400, "Bad request");
    return;
  }

  const requestedPath = path.resolve(root, `.${pathname}`);

  if (requestedPath !== root && !requestedPath.startsWith(`${root}${path.sep}`)) {
    send(response, 403, "Forbidden");
    return;
  }

  servePath(requestedPath, response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`BPAL demo: http://127.0.0.1:${port}/`);
});

function servePath(filePath, response) {
  fs.stat(filePath, (statError, stats) => {
    if (statError) {
      send(response, statError.code === "ENOENT" ? 404 : 500, "Not found");
      return;
    }

    const resolvedPath = stats.isDirectory() ? path.join(filePath, "index.html") : filePath;

    fs.stat(resolvedPath, (fileError, fileStats) => {
      if (fileError || !fileStats.isFile()) {
        send(response, 404, "Not found");
        return;
      }

      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": fileStats.size,
        "Content-Type": mimeTypes.get(path.extname(resolvedPath).toLowerCase()) || "application/octet-stream",
      });
      fs.createReadStream(resolvedPath).pipe(response);
    });
  });
}

function send(response, statusCode, message) {
  response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
}
