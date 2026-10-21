import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

const NewUser = z.object({
  name: z.string(),
  email: z.string().email(),
  age: z.coerce.number().int().min(18),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  switch (req.method) {
    case "GET":
      return res.status(200).json([]);
    case "POST": {
      const user = NewUser.parse(req.body);
      return res.status(201).json(user);
    }
    default:
      res.setHeader("Allow", ["GET", "POST"]);
      return res.status(405).end();
  }
}
