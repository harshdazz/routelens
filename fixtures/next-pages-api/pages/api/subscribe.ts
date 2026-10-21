import type { NextApiRequest, NextApiResponse } from "next";

// No method checks, but it reads a body: RouteLens drafts it as POST.
export default async function subscribe(req: NextApiRequest, res: NextApiResponse) {
  const { email, frequency } = req.body;
  res.status(200).json({ email, frequency });
}
