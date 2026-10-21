// A tiny in-memory API for trying RouteLens. Run with: pnpm demo-server
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 4000);
const posts = [{ id: 1, title: "Hello RouteLens", published: true }];

const send = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

const readJson = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve(undefined);
      }
    });
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  console.log(`${req.method} ${url.pathname}${url.search}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, { status: "ok", time: new Date().toISOString() });
  }

  if (req.method === "GET" && url.pathname === "/api/posts") {
    const published = url.searchParams.get("published");
    const list =
      published === null ? posts : posts.filter((p) => String(p.published) === published);
    return send(res, 200, list);
  }

  if (req.method === "POST" && url.pathname === "/api/posts") {
    const body = await readJson(req);
    if (!body || typeof body.title !== "string" || body.title.trim() === "") {
      return send(res, 400, { error: "title is required and must be a non-empty string" });
    }
    const post = { id: posts.length + 1, title: body.title, published: Boolean(body.published) };
    posts.push(post);
    return send(res, 201, post);
  }

  const match = url.pathname.match(/^\/api\/posts\/(\d+)$/);
  if (req.method === "GET" && match) {
    const post = posts.find((p) => p.id === Number(match[1]));
    return post ? send(res, 200, post) : send(res, 404, { error: "post not found" });
  }

  send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
});

server.listen(PORT, () => {
  console.log(`RouteLens demo server on http://localhost:${PORT}`);
});
