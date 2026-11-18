import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, normalizeMath } from "../src/components/Markdown.tsx";

const render = (md: string) => renderToStaticMarkup(createElement(Markdown, { onJump: () => {}, hasDoc: (a: string) => a === "d2", children: md }));

describe("normalizeMath", () => {
  it("turns a line that is just $$…$$ into a display formula", () => {
    expect(normalizeMath("text\n$$\\sum k$$\nmore")).toBe("text\n$$\n\\sum k\n$$\nmore");
    expect(normalizeMath("  $$ a = b $$  ")).toBe("  $$\n  a = b\n  $$");
  });

  it("leaves inline $$ and block $$ alone", () => {
    expect(normalizeMath("so $$x$$ inline")).toBe("so $$x$$ inline");
    expect(normalizeMath("$$\nx\n$$")).toBe("$$\nx\n$$");
  });

  it("converts \\( \\) and \\[ \\]", () => {
    expect(normalizeMath("\\(x\\) and \\[y\\]")).toBe("$x$ and $$y$$");
  });

  it("leaves fenced code alone", () => {
    const src = "```js\nconst re = /\\(\\d+\\)/;\nconst d = '\\[x\\]';\n```\nand \\(y\\)";
    expect(normalizeMath(src)).toBe("```js\nconst re = /\\(\\d+\\)/;\nconst d = '\\[x\\]';\n```\nand $y$");
    expect(normalizeMath("~~~\n$$x$$\n~~~")).toBe("~~~\n$$x$$\n~~~");
  });

  it("leaves an unclosed fence alone (an answer still streaming)", () => {
    expect(normalizeMath("text \\(a\\)\n```tex\n\\(b\\)")).toBe("text $a$\n```tex\n\\(b\\)");
  });

  it("leaves inline code alone, also with longer backtick runs", () => {
    expect(normalizeMath("write `\\(x\\)` for $x$, or ``a `\\[y\\]` b``")).toBe("write `\\(x\\)` for $x$, or ``a `\\[y\\]` b``");
  });

  it("still converts math next to code", () => {
    expect(normalizeMath("`c`\n$$ a = b $$\nso \\[z\\]")).toBe("`c`\n$$\na = b\n$$\nso $$z$$");
    // A lone backtick doesn't swallow the next paragraph.
    expect(normalizeMath("it's a ` here\n\nand `\\(q\\)")).toBe("it's a ` here\n\nand `$q$");
  });
});

describe("Markdown", () => {
  it("renders display math as a block", () => {
    expect(render("$$\\frac{1}{2}$$")).toContain("katex-display");
    expect(render("a $x$ b")).not.toContain("katex-display");
  });

  it("never loads pictures from other servers", () => {
    for (const src of ["https://evil.example/?q=secret", "HTTPS://evil.example/x", "//evil.example/x.png", "http://127.0.0.1:8787/api/docs", "/api/x.png", "file:///etc/passwd"]) {
      const html = render(`![note text](${src})`);
      expect(html, src).not.toContain("<img");
      expect(html).toContain("[picture: note text]");
    }
  });

  it("doesn't load embedded pictures either", () => {
    expect(render("![dot](data:image/png;base64,iVBORw0KGgo=)")).not.toContain("<img");
  });

  it("renders page citations as buttons, other local links as text", () => {
    const html = render("[p. 2](#page=2) [Slides, p. 3](#doc=d2&page=3) [x](#doc=d9&page=1) [f](/etc/passwd)");
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).not.toContain('href="/etc/passwd"');
  });

  it("does not render raw HTML", () => {
    const html = render('<img src="https://evil.example/x"><script>alert(1)</script>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
  });
});
