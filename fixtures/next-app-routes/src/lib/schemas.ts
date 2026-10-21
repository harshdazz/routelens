import { z } from "zod";

export const Author = z.object({
  name: z.string().min(1),
  email: z.email(),
});

export const CreatePost = z.object({
  title: z.string().min(1),
  body: z.string().max(5000),
  tags: z.array(z.string()).min(1),
  published: z.boolean().default(false),
  author: Author,
  publishAt: z.iso.datetime().optional(),
  website: z.string().url().nullable(),
});

export const createUserSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(20)
    .regex(/^[a-z0-9_]+$/),
  age: z.number().int().positive().optional(),
  role: z.enum(["admin", "member"]).default("member"),
  id: z.uuid(),
});
