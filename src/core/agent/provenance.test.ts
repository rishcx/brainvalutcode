import assert from "node:assert/strict";
import { test } from "node:test";
import { damerau1, hasTimeToken, matchSpan, norm, spanOk } from "./provenance.ts";

test("norm: NFKC, lowercase, punctuation to spaces, collapsed", () => {
  assert.equal(norm("  Call   MOM!!, now "), "call mom now");
  assert.equal(norm("ｃａｌｌ"), "call");
});

test("damerau1: one edit of each kind", () => {
  assert.ok(damerau1("mom", "mum"));
  assert.ok(damerau1("call", "cal"));
  assert.ok(damerau1("remnd", "remind"));
  assert.ok(damerau1("form", "from"));
  assert.ok(!damerau1("mom", "dad"));
});

test("owner false negatives are accepted", () => {
  assert.ok(spanOk("call mum", ["remind me at 6 to call mom"]));
  assert.ok(spanOk("milk", ["add milk to my list"]));
  assert.ok(spanOk("at 6", ["remind me at 6 to stretch"]));
  assert.ok(spanOk("1 min", ["Can you share a reminder of 1 min"]));
  assert.ok(spanOk("to call mom", ["remind me call mom"])); // leading filler dropped
});

test("hallucinated or paraphrased spans are refused", () => {
  assert.ok(!spanOk("drink water", ["Can you share a reminder of 1 min"]));
  assert.ok(!spanOk("buy milk", ["add milk to my list"]));
  assert.ok(!spanOk("in 10 minutes", ["remind me later"]));
  assert.ok(!spanOk("wire money", ["hi"]));
  assert.ok(!spanOk("at 7", ["at 6"])); // digits never fuzzy
  assert.ok(!spanOk("", ["anything"]));
});

test("matchSpan returns the user's own text, not the model's", () => {
  assert.equal(matchSpan("call mum", ["Remind me to Call Mom at 6"]), "Call Mom");
  assert.equal(matchSpan("doctor ko call karna", ["kal subah 9 baje yaad dila dena doctor ko call karna hai"]), "doctor ko call karna");
  assert.equal(matchSpan("buy milk , gym", ["add task buy milk , gym"]), "buy milk , gym");
});

test("hasTimeToken: digits, am/pm and Hinglish words", () => {
  assert.ok(hasTimeToken(["shaam ko remind karna"]));
  assert.ok(hasTimeToken(["x", "at 6"]));
  assert.ok(hasTimeToken(["kal subah"]));
  assert.ok(!hasTimeToken(["remind me later"]));
});
