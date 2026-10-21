import axios from "axios";

// Client code that looks like routes: RouteLens must not list these.
const cache = new Map<string, unknown>();

export function createPost(data: unknown) {
  return axios.post("/api/posts", data);
}

export function cachedPost(id: string) {
  return cache.get(`/api/posts/${id}`);
}
