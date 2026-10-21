const express = require("express");

const app = express();
const port = Number(process.env.PORT ?? 8080);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(port, () => {
  console.log(`API on http://localhost:${port}`);
});
