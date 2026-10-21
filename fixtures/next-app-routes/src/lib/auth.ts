type Handler<Context> = (request: Request, context: Context) => Promise<Response>;

/** A wrapper like the ones auth libraries export: RouteLens must see through it. */
export function withAuth<Context>(handler: Handler<Context>): Handler<Context> {
  return async (request, context) => {
    if (!request.headers.get("authorization")) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    return handler(request, context);
  };
}
