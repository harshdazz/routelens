// Tests are not routes: RouteLens must skip this folder.
import { app } from "../src/app.js";

app.get("/only-in-tests", (_req, res) => {
  res.send("test");
});
