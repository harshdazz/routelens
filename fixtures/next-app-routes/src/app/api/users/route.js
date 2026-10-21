import { createUserSchema } from "../../../lib/schemas";

export async function POST(request) {
  const data = createUserSchema.parse(await request.json());
  return Response.json(data, { status: 201 });
}
