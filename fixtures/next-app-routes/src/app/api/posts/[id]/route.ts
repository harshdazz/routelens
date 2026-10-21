import { z } from "zod";
import { withAuth } from "@/lib/auth";

const UpdatePost = z.object({
  title: z.string().min(3).max(120).optional(),
  status: z.enum(["draft", "published"]),
  rating: z.number().int().min(1).max(5).default(3),
});

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  return Response.json({ id, title: "Hello" });
}

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  const body = await request.json();
  const result = UpdatePost.safeParse(body);
  if (!result.success) {
    return Response.json({ issues: result.error.issues }, { status: 400 });
  }
  return Response.json({ id, ...result.data });
}

export const DELETE = withAuth(async (_request: Request, { params }: Params) => {
  await params;
  return new Response(null, { status: 204 });
});
