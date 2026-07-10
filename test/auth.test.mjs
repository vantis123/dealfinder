// Tests for the web-layer auth gate (lib/auth.mjs).
// Run: node --test   (no dependencies required)
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBasicAuth, constantTimeEqual } from "../lib/auth.mjs";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const basic = (u, p) => `Basic ${b64(`${u}:${p}`)}`;

test("constantTimeEqual: equal strings match", () => {
  assert.equal(constantTimeEqual("hunter2", "hunter2"), true);
});

test("constantTimeEqual: different content does not match", () => {
  assert.equal(constantTimeEqual("hunter2", "hunter3"), false);
});

test("constantTimeEqual: different length does not match", () => {
  assert.equal(constantTimeEqual("abc", "abcd"), false);
  assert.equal(constantTimeEqual("", "x"), false);
});

test("constantTimeEqual: non-strings are rejected", () => {
  assert.equal(constantTimeEqual(null, "x"), false);
  assert.equal(constantTimeEqual("x", undefined), false);
});

test("checkBasicAuth: correct credentials authorize", () => {
  assert.equal(checkBasicAuth(basic("phil", "s3cret"), "phil", "s3cret"), true);
});

test("checkBasicAuth: wrong password rejected", () => {
  assert.equal(checkBasicAuth(basic("phil", "nope"), "phil", "s3cret"), false);
});

test("checkBasicAuth: wrong username rejected", () => {
  assert.equal(checkBasicAuth(basic("eve", "s3cret"), "phil", "s3cret"), false);
});

test("checkBasicAuth: FAILS CLOSED when creds unconfigured", () => {
  // The whole point of the gate: no env config => nobody gets in.
  assert.equal(checkBasicAuth(basic("phil", "s3cret"), undefined, undefined), false);
  assert.equal(checkBasicAuth(basic("phil", "s3cret"), "phil", ""), false);
  assert.equal(checkBasicAuth(basic("phil", "s3cret"), "", "s3cret"), false);
});

test("checkBasicAuth: missing / malformed header rejected", () => {
  assert.equal(checkBasicAuth(null, "phil", "s3cret"), false);
  assert.equal(checkBasicAuth("", "phil", "s3cret"), false);
  assert.equal(checkBasicAuth("Bearer abc", "phil", "s3cret"), false);
  assert.equal(checkBasicAuth("Basic", "phil", "s3cret"), false);
  assert.equal(checkBasicAuth("Basic !!!not-base64!!!", "phil", "s3cret"), false);
});

test("checkBasicAuth: password containing a colon is handled (split on first ':')", () => {
  assert.equal(checkBasicAuth(basic("phil", "a:b:c"), "phil", "a:b:c"), true);
});

test("checkBasicAuth: scheme is case-insensitive", () => {
  assert.equal(checkBasicAuth(`basic ${b64("phil:s3cret")}`, "phil", "s3cret"), true);
});
