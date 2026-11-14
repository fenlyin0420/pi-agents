/**
 * Tests for OpenCode model variant suffixes ("provider/model#variant").
 *
 * A shared agent file declares `model: opencode-go/deepseek-v4.1-flash#high`.
 * pi resolves only the ":" suffix form, so feeding the raw id to the registry
 * put "#high" on the wire and the provider answered "Model is unavailable".
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { splitModelVariant } from "../src/config/model-variant.ts";

test("model-variant: no suffix leaves the reference unchanged", () => {
  assert.deepEqual(splitModelVariant("opencode-go/deepseek-v4.1-flash"), {
    model: "opencode-go/deepseek-v4.1-flash",
  });
});

test("model-variant: thinking-level variant becomes model + thinking", () => {
  assert.deepEqual(splitModelVariant("opencode-go/deepseek-v4.1-flash#high"), {
    model: "opencode-go/deepseek-v4.1-flash",
    variant: "high",
    thinking: "high",
  });
});

test("model-variant: non-thinking variant is split but sets no level", () => {
  assert.deepEqual(splitModelVariant("opencode-go/glm-5.2#thinking"), {
    model: "opencode-go/glm-5.2",
    variant: "thinking",
    thinking: undefined,
  });
});

test("model-variant: undefined reference stays undefined", () => {
  assert.deepEqual(splitModelVariant(undefined), { model: undefined });
});

test("model-variant: leading or dangling # is not a variant", () => {
  assert.deepEqual(splitModelVariant("#high"), { model: "#high" });
  assert.deepEqual(splitModelVariant("opencode-go/glm-5.2#"), { model: "opencode-go/glm-5.2#" });
});
