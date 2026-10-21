import { describe, expect, it } from "vitest";
import { findVariables, interpolate } from "../src/index.js";

describe("interpolate", () => {
  it("replaces known variables, with or without spaces", () => {
    const result = interpolate("{{baseUrl}}/posts/{{ id }}", { baseUrl: "http://x", id: "7" });
    expect(result).toEqual({ value: "http://x/posts/7", missing: [] });
  });

  it("leaves unknown variables in place and reports each once", () => {
    const result = interpolate("{{a}}-{{b}}-{{a}}", {});
    expect(result).toEqual({ value: "{{a}}-{{b}}-{{a}}", missing: ["a", "b"] });
  });

  it("does not treat inherited object keys as variables", () => {
    expect(interpolate("{{toString}}", {}).missing).toEqual(["toString"]);
  });

  it("allows an empty string as a value", () => {
    expect(interpolate("x{{empty}}y", { empty: "" }).value).toBe("xy");
  });
});

describe("findVariables", () => {
  it("lists unique names in order", () => {
    expect(findVariables("{{b}} {{a}} {{b}} {{a.b-c}}")).toEqual(["b", "a", "a.b-c"]);
  });
});
