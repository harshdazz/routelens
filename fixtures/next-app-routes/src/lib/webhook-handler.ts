import { z } from "zod";

export const WebhookEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("post.created"), postId: z.string() }),
  z.object({ type: z.literal("post.deleted"), postId: z.string() }),
]);

export async function POST(request: Request) {
  const event = WebhookEvent.parse(await request.json());
  return Response.json({ received: event.type });
}
