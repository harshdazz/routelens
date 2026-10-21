import express from "express";
import usersRouter from "./routes/users.js";
import { apiRouter } from "./routes/api.js";
import registerHealth from "./routes/health.js";

export const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.send("ok");
});

app.use("/api/users", usersRouter);
app.use("/api", apiRouter);
registerHealth(app);

// A regex path: RouteLens skips it and says so.
app.get(/.*fly$/, (_req, res) => {
  res.send("regex route");
});
