export const GET = async (
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) => {
  const { path } = await params;
  return Response.json({ path: path.join("/") });
};
