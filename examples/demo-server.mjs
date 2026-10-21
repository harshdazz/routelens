// A tiny in-memory API for trying RouteLens. Run with: pnpm demo-server
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 4000);
const posts = [{ id: 1, title: "Hello RouteLens", published: true }];
// Demo login for trying auto-login (M4). Not a real secret: this server is a toy.
const DEMO_USER = { email: "demo@routelens.dev", password: "demo-password" };
const tokens = new Set();

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

  if (req.method === "GET" && url.pathname === "/") {
    return send(res, 200, {
      name: "RouteLens demo API",
      routes: ["GET /api/health", "GET /api/posts", "POST /api/posts", "GET /api/posts/:id"],
      login: ["POST /api/login", "GET /api/me"],
    });
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readJson(req);
    if (body?.email !== DEMO_USER.email || body?.password !== DEMO_USER.password) {
      return send(res, 401, { error: "wrong email or password" });
    }
    const token = `demo-${tokens.size + 1}`;
    tokens.add(token);
    return send(res, 200, { user: { email: DEMO_USER.email }, accessToken: token });
  }

  if (req.method === "GET" && url.pathname === "/api/me") {
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    return tokens.has(token)
      ? send(res, 200, { email: DEMO_USER.email })
      : send(res, 401, { error: "log in first: POST /api/login" });
  }

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
