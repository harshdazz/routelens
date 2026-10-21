async function handler() {
  return Response.json({ users: 3, posts: 12 });
}

export { handler as GET, handler as HEAD };
