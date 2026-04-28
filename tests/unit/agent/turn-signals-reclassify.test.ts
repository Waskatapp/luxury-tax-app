import { describe, expect, it } from "vitest";

import { isRephraseSignal } from "../../../app/lib/agent/turn-signals-reclassify.server";

describe("isRephraseSignal", () => {
  it.each([
    ["no, I meant the cat one", true],
    ["No, the dog one", true],
    ["actually, scratch that", true],
    ["I meant lower the price by 10%", true],
    ["that's not what I meant", true],
    ["wrong, try the snowboard", true],
    ["nope", true],
    ["not what I asked", true],
    ["NO!", true],
  ])("treats %j as rephrase=%s", (text, expected) => {
    expect(isRephraseSignal(text)).toBe(expected);
  });

  it.each([
    ["lower the price of the cat one", false],
    ["yes, do it", false],
    ["thanks", false],
    ["show me my products", false],
    ["create a discount", false],
    // Leading whitespace is tolerated:
    ["   actually, on second thought", true],
  ])("treats %j as rephrase=%s", (text, expected) => {
    expect(isRephraseSignal(text)).toBe(expected);
  });

  it("does not match 'normal' usage that contains the word later in the sentence", () => {
    // "Make sure the title doesn't have 'no' in it" — pattern is anchored
    // at start, so internal 'no' doesn't trigger.
    expect(isRephraseSignal("make sure the title is informative")).toBe(false);
    expect(isRephraseSignal("note this is the new product")).toBe(false);
  });
});
