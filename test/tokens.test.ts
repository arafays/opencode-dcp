import assert from "node:assert/strict"
import { test } from "node:test"

import { countTokens } from "../lib/tokens"

test("countTokens approximates chars/4 and treats empty as zero", () => {
  assert.equal(countTokens(""), 0)
  assert.equal(countTokens("abcd"), 1)
  assert.equal(countTokens("abcdefgh"), 2)
  assert.equal(countTokens("abc"), 1)
})
