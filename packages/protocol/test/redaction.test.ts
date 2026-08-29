import { describe, expect, it } from "vitest";

import { redactFoundrySecretHtml } from "../src/redaction.js";

describe("redactFoundrySecretHtml", () => {
  it("matches secret classes after HTML character-reference and case normalization", () => {
    expect(
      redactFoundrySecretHtml(
        '<p>before</p><SECTION CLASS="journal&#32;sec&#x72;et"><p>hidden</p></SECTION><p>after</p>',
        "[SECRET]",
      ),
    ).toBe("<p>before</p>[SECRET]<p>after</p>");
    expect(
      redactFoundrySecretHtml(
        "<section class='journal&Tab;secret'>hidden</section><section class=secret>also hidden</section>",
        "[SECRET]",
      ),
    ).toBe("[SECRET][SECRET]");
  });

  it("treats non-void section self-closing syntax as an opening tag and ignores quoted decoys", () => {
    expect(
      redactFoundrySecretHtml(
        '<p>before</p><section class="secret" /><span title="</section>">hidden</span></section><p>after</p>',
        "[SECRET]",
      ),
    ).toBe("<p>before</p>[SECRET]<p>after</p>");
    expect(
      redactFoundrySecretHtml(
        '<p data-example="<section class=secret>">visible</p><section class=secret><section>nested</section>hidden</section>',
        "[SECRET]",
      ),
    ).toBe('<p data-example="<section class=secret>">visible</p>[SECRET]');
  });

  it("preserves comments and ordinary content while failing closed on unterminated secrets", () => {
    const ordinary =
      '<!-- <section class=secret>comment</section> --><p class="public">visible</p>';
    expect(redactFoundrySecretHtml(ordinary, "[SECRET]")).toBe(ordinary);
    expect(
      redactFoundrySecretHtml("<p>before</p><div class='secret'>hidden forever", "[SECRET]"),
    ).toBe("<p>before</p>[SECRET]");
  });
});
