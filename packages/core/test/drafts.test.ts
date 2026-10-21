import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  draftRequest,
  findRouteDrafts,
  fingerprint,
  parseRequest,
  readRequestFile,
  serializeRequest,
  syncRouteDrafts,
  updateDraft,
  type ApiRequest,
  type DetectedRoute,
} from "../src/index.js";

const createPost: DetectedRoute = {
  key: "POST /api/posts/:id/comments",
  method: "POST",
  path: "/api/posts/:id/comments",
  anyMethod: false,
  framework: "next-app",
  file: "app/api/posts/[id]/comments/route.ts",
  line: 7,
  body: { sample: { text: "example", rating: 1 }, exact: true, from: "zod", notes: [] },
};

const getHealth: DetectedRoute = {
  key: "GET /api/health",
  method: "GET",
  path: "/api/health",
  anyMethod: false,
  framework: "next-app",
  file: "app/api/health/route.ts",
  line: 1,
};

/** A route after its schema changed: `rating` removed, `author` added. */
const withBody = (sample: Record<string, unknown>): DetectedRoute => ({
  ...createPost,
  body: { sample, exact: true, from: "zod", notes: [] },
});

/** Write a draft, then read it back the way RouteLens reads files. */
const roundTrip = (request: ReturnType<typeof draftRequest>): ApiRequest =>
  parseRequest(serializeRequest(request));

describe("draftRequest", () => {
  it("makes a sendable request with a sample URL and body", () => {
    const draft = roundTrip(draftRequest(createPost));
    expect(draft).toMatchObject({
      name: "POST /api/posts/:id/comments",
      method: "POST",
      url: "{{baseUrl}}/api/posts/1/comments",
      body: { type: "json", content: { text: "example", rating: 1 } },
      route: { key: "POST /api/posts/:id/comments", file: "app/api/posts/[id]/comments/route.ts" },
    });
    expect(draft.route?.generated).toEqual({
      name: fingerprint("POST /api/posts/:id/comments"),
      url: fingerprint("{{baseUrl}}/api/posts/1/comments"),
      "body/text": fingerprint("example"),
      "body/rating": fingerprint(1),
    });
  });

  it("gives a GET no body and a POST without a schema an empty JSON object", () => {
    expect(draftRequest(getHealth).body).toEqual({ type: "none" });
    expect(draftRequest({ ...createPost, body: undefined }).body).toEqual({
      type: "json",
      content: {},
    });
  });
});

describe("updateDraft", () => {
  it("changes nothing when the route did not change", () => {
    expect(updateDraft(roundTrip(draftRequest(createPost)), createPost)).toBeUndefined();
  });

  it("follows schema changes in the values RouteLens wrote", () => {
    const draft = roundTrip(draftRequest(createPost));
    const updated = updateDraft(draft, withBody({ text: "example", author: "user@example.com" }));
    expect(updated?.body).toEqual({
      type: "json",
      content: { text: "example", author: "user@example.com" },
    });
  });

  it("keeps every body key the user edited, added or deleted", () => {
    const draft = roundTrip(draftRequest(createPost));
    draft.body = { type: "json", content: { text: "My comment", debug: true } }; // edited text, deleted rating, added debug
    const updated = roundTrip(
      updateDraft(draft, withBody({ text: "example", rating: 2, author: "x" })) ?? draft,
    );
    expect(updated.body).toEqual({
      type: "json",
      content: { text: "My comment", debug: true, author: "x" },
    });

    // A second sync with the same route changes nothing: the user's choices stick.
    expect(
      updateDraft(updated, withBody({ text: "example", rating: 2, author: "x" })),
    ).toBeUndefined();
  });

  it("updates the URL and name after a rename unless the user changed them", () => {
    const renamed: DetectedRoute = {
      ...createPost,
      key: "POST /api/articles/:id/comments",
      path: "/api/articles/:id/comments",
    };
    const draft = roundTrip(draftRequest(createPost));
    expect(updateDraft(draft, renamed)).toMatchObject({
      name: "POST /api/articles/:id/comments",
      url: "{{baseUrl}}/api/articles/1/comments",
      route: { key: "POST /api/articles/:id/comments" },
    });

    draft.url = "{{baseUrl}}/api/posts/42/comments";
    expect(updateDraft(draft, renamed)).toMatchObject({
      name: "POST /api/articles/:id/comments",
      url: "{{baseUrl}}/api/posts/42/comments",
    });
  });

  it("keeps headers, query and description, which are always the user's", () => {
    const draft = roundTrip(draftRequest(createPost));
    draft.headers = { Authorization: "Bearer {{token}}" };
    draft.query = { draft: "true" };
    draft.description = "Needs a login";
    const updated = updateDraft(draft, withBody({ text: "example" }));
    expect(updated).toMatchObject({
      headers: { Authorization: "Bearer {{token}}" },
      query: { draft: "true" },
      description: "Needs a login",
    });
  });

  it("replaces a whole body only when nobody edited it", () => {
    const noSchema: DetectedRoute = {
      ...createPost,
      method: "DELETE",
      key: "DELETE /x",
      path: "/x",
      body: undefined,
    };
    const draft = roundTrip(draftRequest(noSchema));
    expect(draft.body).toEqual({ type: "none" });
    expect(updateDraft(draft, { ...noSchema, body: createPost.body })?.body).toEqual({
      type: "json",
      content: { text: "example", rating: 1 },
    });

    draft.body = { type: "text", content: "raw" };
    expect(updateDraft(draft, { ...noSchema, body: createPost.body })).toBeUndefined();
  });
});

describe("syncRouteDrafts", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "routelens-drafts-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const draftsDir = (): string => path.join(root, ".routelens", "requests");

  it("creates one draft per route, then leaves them alone", async () => {
    const first = await syncRouteDrafts(root, [getHealth, createPost]);
    expect(first.created.map((file) => path.basename(file))).toEqual([
      "get-api-health.req.json",
      "post-api-posts-id-comments.req.json",
    ]);
    expect(first.known).toEqual(["GET /api/health", "POST /api/posts/:id/comments"]);
    expect(Object.keys(first.drafts)).toEqual(["GET /api/health", "POST /api/posts/:id/comments"]);

    const second = await syncRouteDrafts(root, [getHealth, createPost], { known: first.known });
    expect(second).toMatchObject({ created: [], updated: [], orphaned: [] });
    expect(await findRouteDrafts(root)).toEqual(first.drafts);
  });

  it("does not bring back a draft the user deleted, but creates drafts for new routes", async () => {
    const first = await syncRouteDrafts(root, [getHealth]);
    await unlink(path.join(draftsDir(), "get-api-health.req.json"));
    const second = await syncRouteDrafts(root, [getHealth, createPost], { known: first.known });
    expect(second.created.map((file) => path.basename(file))).toEqual([
      "post-api-posts-id-comments.req.json",
    ]);
    expect(second.drafts["GET /api/health"]).toBeUndefined();
  });

  it("updates drafts when the code changes, keeping the user's edits", async () => {
    const { drafts, known } = await syncRouteDrafts(root, [createPost]);
    const file = drafts[createPost.key] ?? "";
    const request = await readRequestFile(file);
    request.body = { type: "json", content: { text: "Hello", rating: 1 } };
    await writeFile(file, serializeRequest(request));

    const result = await syncRouteDrafts(
      root,
      [withBody({ text: "example", rating: 1, author: "a" })],
      { known },
    );
    expect(result.updated).toEqual([file]);
    expect((await readRequestFile(file)).body).toEqual({
      type: "json",
      content: { text: "Hello", rating: 1, author: "a" },
    });
  });

  it("moves a draft with its route when the path is renamed in the same file", async () => {
    const { drafts, known } = await syncRouteDrafts(root, [createPost]);
    const renamed: DetectedRoute = {
      ...createPost,
      key: "POST /api/articles/:id/comments",
      path: "/api/articles/:id/comments",
    };
    const result = await syncRouteDrafts(root, [renamed], { known });
    expect(result).toMatchObject({ created: [], orphaned: [] });
    expect(result.drafts[renamed.key]).toBe(drafts[createPost.key]);
    expect(await readRequestFile(drafts[createPost.key] ?? "")).toMatchObject({
      url: "{{baseUrl}}/api/articles/1/comments",
      route: { key: renamed.key },
    });
  });

  it("reports drafts whose route is gone, and never deletes them", async () => {
    const { known, drafts } = await syncRouteDrafts(root, [getHealth, createPost]);
    const result = await syncRouteDrafts(root, [getHealth], { known });
    expect(result.orphaned).toEqual([drafts[createPost.key]]);
    expect(await readFile(drafts[createPost.key] ?? "", "utf8")).toContain(createPost.key);
  });

  it("skips files it is told to skip and never touches broken or unlinked files", async () => {
    const { drafts, known } = await syncRouteDrafts(root, [createPost]);
    const file = drafts[createPost.key] ?? "";
    const broken = path.join(draftsDir(), "broken.req.json");
    const handWritten = path.join(draftsDir(), "post-api-posts-id-comments-2.req.json");
    await writeFile(broken, "{ not json");

    const skipped = await syncRouteDrafts(root, [withBody({ changed: true })], {
      known,
      skip: (item) => item === file,
    });
    expect(skipped.updated).toEqual([]);
    expect(await readFile(broken, "utf8")).toBe("{ not json");

    // A new route whose file name is taken gets a numbered name.
    const sameSlug: DetectedRoute = {
      ...createPost,
      key: "POST /api/posts/:id/comments/",
      path: "/api/posts/:id/comments/",
    };
    const created = await syncRouteDrafts(root, [createPost, sameSlug], { known });
    expect(created.created).toEqual([handWritten]);
  });
});
