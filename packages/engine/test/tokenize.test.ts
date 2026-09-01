import { describe, expect, it } from "vitest";
import { tokenize } from "../src/tokenize.js";

describe("search tokenization", () => {
  it("expands CJK natural-language phrases into overlapping trigrams", () => {
    const tokens = tokenize("我之前看过 AI 落地不是会工具，而是交付工作流结果");
    expect(tokens).toEqual(expect.arrayContaining(["我之前", "之前看", "落地不", "工作流", "作流结", "流结果", "ai"]));
    expect(tokens).not.toContain("落地不是会工具");
  });

  it("keeps short CJK terms and removes duplicate trigrams", () => {
    expect(tokenize("白模 白模")).toEqual(["白模"]);
  });
});
