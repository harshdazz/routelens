import type { NextApiRequest, NextApiResponse } from "next";
import { Order } from "../../lib/schemas";

export default function createOrder(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).end();
  }
  const order = Order.parse(req.body);
  return res.status(201).json(order);
}
