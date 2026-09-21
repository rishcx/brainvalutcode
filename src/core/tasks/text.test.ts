import assert from "node:assert/strict";
import { test } from "node:test";
import { mdEscape, sanitiseTitle, slugify } from "./text.ts";

test("sanitiseTitle strips controls, zero-width, bidi, BOM; collapses; caps", () => {
  assert.equal(sanitiseTitle("  a​b‮c⁦d﻿\u0007e \n\t f  "), "abcde f");
  assert.equal(sanitiseTitle("x y z"), "xyz");
  assert.equal(sanitiseTitle("​ \n "), "");
  assert.equal(sanitiseTitle("ｆｕｌｌ"), "full"); // NFKC
  assert.equal(sanitiseTitle("a".repeat(10_000)).length, 200);
});

test("mdEscape escapes markdown metacharacters", () => {
  assert.equal(mdEscape("# H [[x]] <b> a_b*c|d~e`f\\g & h"), "\\# H \\[\\[x\\]\\] \\<b\\> a\\_b\\*c\\|d\\~e\\`f\\\\g &amp; h");
});

test("slugify", () => {
  assert.equal(slugify("Pay the Bill!!"), "pay-the-bill");
  assert.equal(slugify("日本語"), "task");
  assert.equal(slugify("x".repeat(60)).length, 40);
});
