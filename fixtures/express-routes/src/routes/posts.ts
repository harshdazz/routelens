import { Router } from "express";
import { PostInput } from "../schemas/post.js";

const router = Router();

router.get("/", (_req, res) => {
  res.json([]);
});

router.post("/", async (req, res) => {
  const result = PostInput.safeParse(req.body);
  if (!result.success) {
    res.status(400).json(result.error.issues);
    return;
  }
  res.status(201).json(result.data);
});

router.patch("/:postId/publish", (req, res) => {
  res.json({ id: req.params.postId, published: true });
});

export default router;
