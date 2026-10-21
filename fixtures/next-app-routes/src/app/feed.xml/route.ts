export async function GET() {
  return new Response('<rss version="2.0"></rss>', {
    headers: { "Content-Type": "application/rss+xml" },
  });
}
