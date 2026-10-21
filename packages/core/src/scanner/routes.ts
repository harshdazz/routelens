import type { HttpMethod } from "../model.js";
import type { RouteBody } from "./body.js";

export type RouteFramework = "next-app" | "next-pages" | "express";

/** An API route found in the code. */
export interface DetectedRoute {
  /** Identity of the route: method + path, e.g. `POST /api/posts/:id`. */
  key: string;
  method: HttpMethod;
  /** Express-style path for every framework: `/api/posts/:id`, `/files/*path`, `/docs{/*slug}`. */
  path: string;
  /** The handler answers every method (`app.all`, a Pages API route without method checks). */
  anyMethod: boolean;
  framework: RouteFramework;
  /** File of the handler, relative to the root, with `/`. */
  file: string;
  /** 1-based line where the handler is declared, for the ▶ Send button above it. */
  line: number;
  /** The body the handler expects, when RouteLens could tell. */
  body?: RouteBody;
}

/** Something that looks like a route but could not be read, so it is reported instead. */
export interface SkippedRoute {
  file: string;
  line: number;
  reason: string;
}

export interface ScanResult {
  routes: DetectedRoute[];
  skipped: SkippedRoute[];
  /** Frameworks found in package.json and scanned. */
  frameworks: RouteFramework[];
  /** How many source files were looked at. */
  filesScanned: number;
}
