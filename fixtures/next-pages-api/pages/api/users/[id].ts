import type { NextApiHandler } from "next";
import { UpdateUser } from "../../../lib/schemas";

const handler: NextApiHandler = async (req, res) => {
  const { id } = req.query;
  if (req.method === "GET") {
    return res.status(200).json({ id });
  }
  if (req.method === "PUT") {
    const data = UpdateUser.parse(req.body);
    return res.status(200).json({ id, ...data });
  }
  if (req.method === "DELETE") {
    return res.status(204).end();
  }
  res.status(405).end();
};

export default handler;
