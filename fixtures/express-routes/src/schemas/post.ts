import { z } from "zod";

export const PostInput = z.object({
  title: z.string().min(1),
  tags: z.array(z.string()).max(5).default([]),
  meta: z.record(z.string(), z.string()).optional(),
  score: z.number().gt(0).lte(10),
});
