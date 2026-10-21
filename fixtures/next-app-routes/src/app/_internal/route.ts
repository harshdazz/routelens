// Private folder (starts with "_"): Next.js does not route it, so RouteLens must skip it.
export async function GET() {
  return Response.json({ secret: false });
}
