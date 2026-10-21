import type { NextApiRequest, NextApiResponse } from "next";

export const config = { api: { bodyParser: false } };

export default (_req: NextApiRequest, res: NextApiResponse) => res.json({ ok: true });
