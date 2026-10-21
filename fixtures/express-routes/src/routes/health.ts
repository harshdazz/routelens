import type { Express } from "express";

/** Registers routes on the app it receives. */
export default function registerHealth(app: Express) {
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/ready", (_req, res) => {
    res.json({ ready: true });
  });
}
