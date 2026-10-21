import { Router } from "express";
import postsRouter from "./posts.js";
import legacy from "./legacy.cjs";

export const apiRouter = Router();

apiRouter.use("/posts", postsRouter);
apiRouter.use("/legacy", legacy);
apiRouter.all("/ping", (_req, res) => {
  res.send("pong");
});
