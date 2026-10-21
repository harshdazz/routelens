import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";

const CreateUser = z.object({
  name: z.string().min(2),
  email: z.email(),
  plan: z.enum(["free", "pro"]).default("free"),
});

const UpdateUser = CreateUser.partial().extend({ active: z.boolean() });

const router = Router();

function listUsers(_req: Request, res: Response) {
  res.json([]);
}

function createUser(req: Request, res: Response) {
  res.status(201).json(req.body);
}

router.get("/", listUsers);
router.post("/", validate(CreateUser), createUser);

router
  .route("/:id")
  .get((req, res) => {
    res.json({ id: req.params.id });
  })
  .put((req, res) => {
    const data = UpdateUser.parse(req.body);
    res.json(data);
  })
  .delete((_req, res) => {
    res.status(204).end();
  });

export default router;
