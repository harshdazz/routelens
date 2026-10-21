import { NextResponse, type NextRequest } from "next/server";
import { CreatePost } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const page = request.nextUrl.searchParams.get("page") ?? "1";
  return NextResponse.json({ page, posts: [] });
}

export async function POST(request: Request) {
  const input = CreatePost.parse(await request.json());
  return NextResponse.json(input, { status: 201 });
}
