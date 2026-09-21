import assert from "node:assert/strict";
import { test } from "node:test";
import { replyLanguage } from "./lang.ts";

test("English stays English (the live bug: English GitHub questions were answered in Hinglish)", () => {
  for (const m of ["any issues open on my github", "tell me more about the first one", "hi", "set a reminder", "what are todays tasks", "remind me at 6 pm to call mom", "par for the course"]) {
    assert.equal(replyLanguage(m), "English", m);
  }
});

test("clear Hinglish or Hindi is detected", () => {
  for (const m of ["kal subah 9 baje yaad dilana", "mujhe aaj ke tasks batao", "kya hai", "mere github issues dikhao"]) assert.equal(replyLanguage(m), "Hinglish", m);
  assert.equal(replyLanguage("मुझे याद दिलाना"), "Hindi");
});
