/* Bundled from @allowly/verifier 4.1.0 at allowly-receipt-format d35f181. See THIRD_PARTY_NOTICES.md. */
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ../allowly-receipt-format/verifiers/typescript/seal-verifier-entry.js
var seal_verifier_entry_exports = {};
__export(seal_verifier_entry_exports, {
  SEAL_MAX_DEPTH: () => SEAL_MAX_DEPTH,
  SEAL_MAX_UTF8_BYTES: () => SEAL_MAX_UTF8_BYTES,
  SEAL_PROFILE: () => SEAL_PROFILE,
  SealInputError: () => SealInputError,
  hashSealJson: () => hashSealJson,
  hashSealValue: () => hashSealValue,
  loadKeysFromJson: () => loadKeysFromJson,
  publicKeyFingerprint: () => publicKeyFingerprint,
  verifySealJson: () => verifySealJson,
  verifySealValue: () => verifySealValue
});
module.exports = __toCommonJS(seal_verifier_entry_exports);

// ../allowly-receipt-format/verifiers/typescript/dist/verifier.js
var import_node_crypto = require("node:crypto");

// ../allowly-receipt-format/verifiers/typescript/node_modules/canonicalize/lib/canonicalize.js
function canonicalize(object, seen = /* @__PURE__ */ new Set()) {
  if (typeof object === "number" && isNaN(object)) {
    throw new Error("NaN is not allowed");
  }
  if (typeof object === "number" && !isFinite(object)) {
    throw new Error("Infinity is not allowed");
  }
  if (object === null || typeof object !== "object") {
    return JSON.stringify(object);
  }
  if (typeof object.toJSON === "function") {
    if (seen.has(object)) {
      throw new Error("Circular reference detected");
    }
    seen.add(object);
    const result2 = canonicalize(object.toJSON(), seen);
    seen.delete(object);
    return result2;
  }
  if (seen.has(object)) {
    throw new Error("Circular reference detected");
  }
  seen.add(object);
  let result;
  if (Array.isArray(object)) {
    const values = object.map((cv) => {
      const value = cv === void 0 || typeof cv === "symbol" ? null : cv;
      return canonicalize(value, seen);
    });
    result = `[${values.join(",")}]`;
  } else {
    const parts = [];
    for (const key of Object.keys(object).sort()) {
      if (object[key] === void 0 || typeof object[key] === "symbol") {
        continue;
      }
      parts.push(`${canonicalize(key)}:${canonicalize(object[key], seen)}`);
    }
    result = `{${parts.join(",")}}`;
  }
  seen.delete(object);
  return result;
}

// ../allowly-receipt-format/verifiers/typescript/node_modules/lossless-json/lib/esm/utils.js
function isInteger(value) {
  return INTEGER_REGEX.test(value);
}
var INTEGER_REGEX = /^-?[0-9]+$/;
function isNumber(value) {
  return NUMBER_REGEX.test(value);
}
var NUMBER_REGEX = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
function isSafeNumber(value, config2) {
  if (isInteger(value)) {
    return Number.isSafeInteger(Number.parseInt(value, 10));
  }
  const num = Number.parseFloat(value);
  const parsed = String(num);
  if (value === parsed) {
    return true;
  }
  const valueDigits = extractSignificantDigits(value);
  const parsedDigits = extractSignificantDigits(parsed);
  if (valueDigits === parsedDigits) {
    return true;
  }
  if (config2?.approx === true) {
    const requiredDigits = 14;
    if (!isInteger(value) && parsedDigits.length >= requiredDigits && valueDigits.startsWith(parsedDigits.substring(0, requiredDigits))) {
      return true;
    }
  }
  return false;
}
var UnsafeNumberReason = /* @__PURE__ */ (function(UnsafeNumberReason2) {
  UnsafeNumberReason2["underflow"] = "underflow";
  UnsafeNumberReason2["overflow"] = "overflow";
  UnsafeNumberReason2["truncate_integer"] = "truncate_integer";
  UnsafeNumberReason2["truncate_float"] = "truncate_float";
  return UnsafeNumberReason2;
})({});
function getUnsafeNumberReason(value) {
  if (isSafeNumber(value, {
    approx: false
  })) {
    return void 0;
  }
  if (isInteger(value)) {
    return UnsafeNumberReason.truncate_integer;
  }
  const num = Number.parseFloat(value);
  if (!Number.isFinite(num)) {
    return UnsafeNumberReason.overflow;
  }
  if (num === 0) {
    return UnsafeNumberReason.underflow;
  }
  return UnsafeNumberReason.truncate_float;
}
function extractSignificantDigits(value) {
  const {
    start,
    end
  } = getSignificantDigitRange(value);
  const digits = value.substring(start, end);
  const dot = digits.indexOf(".");
  if (dot === -1) {
    return digits;
  }
  return digits.substring(0, dot) + digits.substring(dot + 1);
}
function getSignificantDigitRange(value) {
  let start = 0;
  if (value[0] === "-") {
    start++;
  }
  while (value[start] === "0" || value[start] === ".") {
    start++;
  }
  let end = value.lastIndexOf("e");
  if (end === -1) {
    end = value.lastIndexOf("E");
  }
  if (end === -1) {
    end = value.length;
  }
  while ((value[end - 1] === "0" || value[end - 1] === ".") && end > start) {
    end--;
  }
  return {
    start,
    end
  };
}

// ../allowly-receipt-format/verifiers/typescript/node_modules/lossless-json/lib/esm/LosslessNumber.js
var LosslessNumber = class {
  // numeric value as string
  // type information
  isLosslessNumber = true;
  constructor(value) {
    if (!isNumber(value)) {
      throw new Error(`Invalid number (value: "${value}")`);
    }
    this.value = value;
  }
  /**
   * Get the value of the LosslessNumber as number or bigint.
   *
   * - a number is returned for safe numbers and decimal values that only lose some insignificant digits
   * - a bigint is returned for big integer numbers
   * - an Error is thrown for values that will overflow or underflow
   *
   * Note that you can implement your own strategy for conversion by just getting the value as string
   * via .toString(), and using util functions like isInteger, isSafeNumber, getUnsafeNumberReason,
   * and toSafeNumberOrThrow to convert it to a numeric value.
   */
  valueOf() {
    const unsafeReason = getUnsafeNumberReason(this.value);
    if (unsafeReason === void 0 || unsafeReason === UnsafeNumberReason.truncate_float) {
      return Number.parseFloat(this.value);
    }
    if (isInteger(this.value)) {
      return BigInt(this.value);
    }
    throw new Error(`Cannot safely convert to number: the value '${this.value}' would ${unsafeReason} and become ${Number.parseFloat(this.value)}`);
  }
  /**
   * Get the value of the LosslessNumber as string.
   */
  toString() {
    return this.value;
  }
  // Note: we do NOT implement a .toJSON() method, and you should not implement
  // or use that, it cannot safely turn the numeric value in the string into
  // stringified JSON since it has to be parsed into a number first.
};
function isLosslessNumber(value) {
  return value && typeof value === "object" && value.isLosslessNumber || false;
}

// ../allowly-receipt-format/verifiers/typescript/node_modules/lossless-json/lib/esm/numberParsers.js
function parseLosslessNumber(value) {
  return new LosslessNumber(value);
}

// ../allowly-receipt-format/verifiers/typescript/node_modules/lossless-json/lib/esm/revive.js
function revive(json, reviver) {
  return reviveValue({
    "": json
  }, "", json, reviver);
}
function reviveValue(context, key, value, reviver) {
  if (Array.isArray(value)) {
    return reviver.call(context, key, reviveArray(value, reviver));
  }
  if (value && typeof value === "object" && !isLosslessNumber(value)) {
    return reviver.call(context, key, reviveObject(value, reviver));
  }
  return reviver.call(context, key, value);
}
function reviveObject(object, reviver) {
  for (const key of Object.keys(object)) {
    const value = reviveValue(object, key, object[key], reviver);
    if (value !== void 0) {
      object[key] = value;
    } else {
      delete object[key];
    }
  }
  return object;
}
function reviveArray(array, reviver) {
  for (let i = 0; i < array.length; i++) {
    array[i] = reviveValue(array, String(i), array[i], reviver);
  }
  return array;
}

// ../allowly-receipt-format/verifiers/typescript/node_modules/lossless-json/lib/esm/parse.js
function parse(text, reviver, options) {
  const optionsObj = typeof options === "function" ? {
    parseNumber: options
  } : options;
  const parseNumber = optionsObj?.parseNumber ?? parseLosslessNumber;
  const onDuplicateKey = optionsObj?.onDuplicateKey ?? throwDuplicateKey;
  let i = 0;
  const value = parseValue();
  expectValue(value);
  expectEndOfInput();
  return reviver ? revive(value, reviver) : value;
  function parseObject() {
    if (text.charCodeAt(i) === codeOpeningBrace) {
      i++;
      skipWhitespace();
      const object = {};
      let initial = true;
      while (i < text.length && text.charCodeAt(i) !== codeClosingBrace) {
        if (!initial) {
          eatComma();
          skipWhitespace();
        } else {
          initial = false;
        }
        const start = i;
        const key = parseString();
        if (key === void 0) {
          throwObjectKeyExpected();
          return;
        }
        skipWhitespace();
        eatColon();
        const value2 = parseValue();
        if (value2 === void 0) {
          throwObjectValueExpected();
          return;
        }
        if (Object.prototype.hasOwnProperty.call(object, key) && !isDeepEqual(value2, object[key])) {
          const returnedValue = onDuplicateKey({
            key,
            position: start + 1,
            oldValue: object[key],
            newValue: value2
          });
          if (returnedValue !== void 0) {
            object[key] = returnedValue;
          }
        } else {
          object[key] = value2;
        }
      }
      if (text.charCodeAt(i) !== codeClosingBrace) {
        throwObjectKeyOrEndExpected();
      }
      i++;
      return object;
    }
  }
  function parseArray() {
    if (text.charCodeAt(i) === codeOpeningBracket) {
      i++;
      skipWhitespace();
      const array = [];
      let initial = true;
      while (i < text.length && text.charCodeAt(i) !== codeClosingBracket) {
        if (!initial) {
          eatComma();
        } else {
          initial = false;
        }
        const value2 = parseValue();
        expectArrayItem(value2);
        array.push(value2);
      }
      if (text.charCodeAt(i) !== codeClosingBracket) {
        throwArrayItemOrEndExpected();
      }
      i++;
      return array;
    }
  }
  function parseValue() {
    skipWhitespace();
    const value2 = parseString() ?? parseNumeric() ?? parseObject() ?? parseArray() ?? parseKeyword("true", true) ?? parseKeyword("false", false) ?? parseKeyword("null", null);
    skipWhitespace();
    return value2;
  }
  function parseKeyword(name, value2) {
    if (text.slice(i, i + name.length) === name) {
      i += name.length;
      return value2;
    }
  }
  function skipWhitespace() {
    while (isWhitespace(text.charCodeAt(i))) {
      i++;
    }
  }
  function parseString() {
    if (text.charCodeAt(i) === codeDoubleQuote) {
      i++;
      let result = "";
      while (i < text.length && text.charCodeAt(i) !== codeDoubleQuote) {
        if (text.charCodeAt(i) === codeBackslash) {
          const char = text[i + 1];
          const escapeChar = escapeCharacters[char];
          if (escapeChar !== void 0) {
            result += escapeChar;
            i++;
          } else if (char === "u") {
            if (isHex(text.charCodeAt(i + 2)) && isHex(text.charCodeAt(i + 3)) && isHex(text.charCodeAt(i + 4)) && isHex(text.charCodeAt(i + 5))) {
              result += String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16));
              i += 5;
            } else {
              throwInvalidUnicodeCharacter(i);
            }
          } else {
            throwInvalidEscapeCharacter(i);
          }
        } else {
          if (isValidStringCharacter(text.charCodeAt(i))) {
            result += text[i];
          } else {
            throwInvalidCharacter(text[i]);
          }
        }
        i++;
      }
      expectEndOfString();
      i++;
      return result;
    }
  }
  function parseNumeric() {
    const start = i;
    if (text.charCodeAt(i) === codeMinus) {
      i++;
      expectDigit(start);
    }
    if (text.charCodeAt(i) === codeZero) {
      i++;
    } else if (isNonZeroDigit(text.charCodeAt(i))) {
      i++;
      while (isDigit(text.charCodeAt(i))) {
        i++;
      }
    }
    if (text.charCodeAt(i) === codeDot) {
      i++;
      expectDigit(start);
      while (isDigit(text.charCodeAt(i))) {
        i++;
      }
    }
    if (text.charCodeAt(i) === codeLowercaseE || text.charCodeAt(i) === codeUppercaseE) {
      i++;
      if (text.charCodeAt(i) === codeMinus || text.charCodeAt(i) === codePlus) {
        i++;
      }
      expectDigit(start);
      while (isDigit(text.charCodeAt(i))) {
        i++;
      }
    }
    if (i > start) {
      return parseNumber(text.slice(start, i));
    }
  }
  function eatComma() {
    if (text.charCodeAt(i) !== codeComma) {
      throw new SyntaxError(`Comma ',' expected after value ${gotAt()}`);
    }
    i++;
  }
  function eatColon() {
    if (text.charCodeAt(i) !== codeColon) {
      throw new SyntaxError(`Colon ':' expected after property name ${gotAt()}`);
    }
    i++;
  }
  function expectValue(value2) {
    if (value2 === void 0) {
      throw new SyntaxError(`JSON value expected ${gotAt()}`);
    }
  }
  function expectArrayItem(value2) {
    if (value2 === void 0) {
      throw new SyntaxError(`Array item expected ${gotAt()}`);
    }
  }
  function expectEndOfInput() {
    if (i < text.length) {
      throw new SyntaxError(`Expected end of input ${gotAt()}`);
    }
  }
  function expectDigit(start) {
    if (!isDigit(text.charCodeAt(i))) {
      const numSoFar = text.slice(start, i);
      throw new SyntaxError(`Invalid number '${numSoFar}', expecting a digit ${gotAt()}`);
    }
  }
  function expectEndOfString() {
    if (text.charCodeAt(i) !== codeDoubleQuote) {
      throw new SyntaxError(`End of string '"' expected ${gotAt()}`);
    }
  }
  function throwObjectKeyExpected() {
    throw new SyntaxError(`Quoted object key expected ${gotAt()}`);
  }
  function throwDuplicateKey(_ref) {
    let {
      key,
      position
    } = _ref;
    throw new SyntaxError(`Duplicate key '${key}' encountered at position ${position}`);
  }
  function throwObjectKeyOrEndExpected() {
    throw new SyntaxError(`Quoted object key or end of object '}' expected ${gotAt()}`);
  }
  function throwArrayItemOrEndExpected() {
    throw new SyntaxError(`Array item or end of array ']' expected ${gotAt()}`);
  }
  function throwInvalidCharacter(char) {
    throw new SyntaxError(`Invalid character '${char}' ${pos()}`);
  }
  function throwInvalidEscapeCharacter(start) {
    const chars = text.slice(start, start + 2);
    throw new SyntaxError(`Invalid escape character '${chars}' ${pos()}`);
  }
  function throwObjectValueExpected() {
    throw new SyntaxError(`Object value expected after ':' ${pos()}`);
  }
  function throwInvalidUnicodeCharacter(start) {
    const chars = text.slice(start, start + 6);
    throw new SyntaxError(`Invalid unicode character '${chars}' ${pos()}`);
  }
  function pos() {
    return `at position ${i}`;
  }
  function got() {
    return i < text.length ? `but got '${text[i]}'` : "but reached end of input";
  }
  function gotAt() {
    return `${got()} ${pos()}`;
  }
}
function isWhitespace(code) {
  return code === codeSpace || code === codeNewline || code === codeTab || code === codeReturn;
}
function isHex(code) {
  return code >= codeZero && code <= codeNine || code >= codeUppercaseA && code <= codeUppercaseF || code >= codeLowercaseA && code <= codeLowercaseF;
}
function isDigit(code) {
  return code >= codeZero && code <= codeNine;
}
function isNonZeroDigit(code) {
  return code >= codeOne && code <= codeNine;
}
function isValidStringCharacter(code) {
  return code >= 32 && code <= 1114111;
}
function isDeepEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => isDeepEqual(item, b[index]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = [.../* @__PURE__ */ new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.every((key) => isDeepEqual(a[key], b[key]));
  }
  return false;
}
function isObject(value) {
  return typeof value === "object" && value !== null;
}
var escapeCharacters = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "	"
  // note that \u is handled separately in parseString()
};
var codeBackslash = 92;
var codeOpeningBrace = 123;
var codeClosingBrace = 125;
var codeOpeningBracket = 91;
var codeClosingBracket = 93;
var codeSpace = 32;
var codeNewline = 10;
var codeTab = 9;
var codeReturn = 13;
var codeDoubleQuote = 34;
var codePlus = 43;
var codeMinus = 45;
var codeZero = 48;
var codeOne = 49;
var codeNine = 57;
var codeComma = 44;
var codeDot = 46;
var codeColon = 58;
var codeUppercaseA = 65;
var codeLowercaseA = 97;
var codeUppercaseE = 69;
var codeLowercaseE = 101;
var codeUppercaseF = 70;
var codeLowercaseF = 102;

// ../allowly-receipt-format/verifiers/typescript/dist/verifier.js
var SPEC_VERSION = "4";
var ACTION_DECISIONS = /* @__PURE__ */ new Set(["allow", "deny", "confirm", "escalate"]);
var EVENT_DECISIONS = {
  "authorization.create": /* @__PURE__ */ new Set(["authorization_granted"]),
  "authorization.revoke": /* @__PURE__ */ new Set(["authorization_revoked"]),
  "budget.settle": /* @__PURE__ */ new Set(["budget_settled"]),
  "escalation.resolve": /* @__PURE__ */ new Set(["escalation_approved", "escalation_rejected"]),
  "receipt.checkpoint": /* @__PURE__ */ new Set(["receipt_set_committed"])
};
var AUTHORIZATION_LIFECYCLE_EVENTS = /* @__PURE__ */ new Set(["authorization.create", "authorization.revoke"]);
var EVENT_ONLY_DECISIONS = new Set(Object.values(EVENT_DECISIONS).flatMap((decisions) => [...decisions]));
var REQUIRED_FIELDS = /* @__PURE__ */ new Set([
  "schema_version",
  "receipt_id",
  "workspace_id",
  "issued_at",
  "decision",
  "reason",
  "user_id",
  "agent_id",
  "resource",
  "context",
  "authorization_id",
  "engine_version",
  "alg",
  "key_id",
  "signature"
]);
var OPTIONAL_FIELDS = /* @__PURE__ */ new Set(["policy_eval"]);
var DISCRIMINATOR_FIELDS = /* @__PURE__ */ new Set(["action", "event"]);
var ALL_TOP_LEVEL_FIELDS = /* @__PURE__ */ new Set([
  ...REQUIRED_FIELDS,
  ...DISCRIMINATOR_FIELDS,
  ...OPTIONAL_FIELDS
]);
var MAX_FUTURE_SKEW_MS = 5 * 60 * 1e3;
var VerificationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "VerificationError";
  }
};
function publicKeyFingerprint(key) {
  return "sha256:" + (0, import_node_crypto.createHash)("sha256").update(key.publicKeyBytes).digest("hex");
}
var B64URL_RE = /^[A-Za-z0-9_-]*$/;
function b64urlDecode(s) {
  if (!B64URL_RE.test(s)) {
    throw new VerificationError(`not unpadded base64url: ${JSON.stringify(s)}`);
  }
  const padded = s + "=".repeat((4 - s.length % 4) % 4);
  const standard = padded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = Buffer.from(standard, "base64");
  if (binary.toString("base64url") !== s) {
    throw new VerificationError(`non-canonical base64url: ${JSON.stringify(s)}`);
  }
  return new Uint8Array(binary);
}
var MAX_PAYLOAD_DEPTH = 32;
var MAX_PAYLOAD_NODES = 5e4;
function canonicalize2(payload) {
  const snapshot = snapshotJson(payload, "payload");
  const s = stringify2(snapshot);
  return new TextEncoder().encode(s);
}
function snapshotJson(value, label, checkCanonicalNumbers = true) {
  validateTree(value, checkCanonicalNumbers);
  let snapshot;
  try {
    snapshot = structuredClone(value);
  } catch {
    throw new VerificationError(`${label} must be structured-cloneable JSON data`);
  }
  validateTree(snapshot, checkCanonicalNumbers);
  return snapshot;
}
function validateTree(payload, checkCanonicalNumbers = true) {
  let nodes = 0;
  const stack = [[payload, 1]];
  while (stack.length > 0) {
    const [value, depth] = stack.pop();
    nodes += 1;
    if (depth > MAX_PAYLOAD_DEPTH) {
      throw new VerificationError(`payload nesting exceeds max depth ${MAX_PAYLOAD_DEPTH}`);
    }
    if (nodes > MAX_PAYLOAD_NODES) {
      throw new VerificationError(`payload exceeds max node count ${MAX_PAYLOAD_NODES}`);
    }
    if (typeof value === "number") {
      if (checkCanonicalNumbers && !Number.isInteger(value)) {
        throw new VerificationError("receipts must not contain non-integer numbers");
      }
      if (checkCanonicalNumbers && !Number.isSafeInteger(value)) {
        throw new VerificationError("integer exceeds the safe range \xB1(2^53-1); receipts must not carry integers that lose precision in IEEE-754 doubles");
      }
    } else if (typeof value === "string") {
      if (!value.isWellFormed()) {
        throw new VerificationError("string contains an unpaired Unicode surrogate");
      }
    } else if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        throw new VerificationError("payload arrays must be dense JSON arrays without extra properties");
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (!("value" in descriptor)) {
          throw new VerificationError("payload must not contain accessor properties");
        }
        stack.push([descriptor.value, depth + 1]);
      }
    } else if (value !== null && typeof value === "object") {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new VerificationError("payload objects must be plain JSON objects");
      }
      for (const [k, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (!descriptor.enumerable)
          continue;
        if (!k.isWellFormed()) {
          throw new VerificationError("string contains an unpaired Unicode surrogate");
        }
        if (!("value" in descriptor)) {
          throw new VerificationError("payload must not contain accessor properties");
        }
        stack.push([descriptor.value, depth + 1]);
      }
    } else if (value !== null && !["boolean", "number", "string"].includes(typeof value)) {
      throw new VerificationError(`unsupported type in payload: ${typeof value}`);
    }
  }
}
function stringify2(v) {
  if (v === null)
    return "null";
  if (typeof v === "boolean")
    return v ? "true" : "false";
  if (typeof v === "number") {
    return String(v);
  }
  if (typeof v === "string")
    return encodeString(v);
  if (Array.isArray(v)) {
    return "[" + v.map(stringify2).join(",") + "]";
  }
  if (typeof v === "object") {
    const entries = Object.entries(v);
    entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return "{" + entries.map(([k, val]) => encodeString(k) + ":" + stringify2(val)).join(",") + "}";
  }
  throw new VerificationError(`unsupported type in payload: ${typeof v}`);
}
function encodeString(s) {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (ch === '"')
      out += '\\"';
    else if (ch === "\\")
      out += "\\\\";
    else if (code < 32) {
      out += "\\u" + code.toString(16).padStart(4, "0");
    } else {
      out += ch;
    }
  }
  out += '"';
  return out;
}
async function verifyReceipt(receipt, publicKeys, opts = {}) {
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) {
    throw new VerificationError("receipt must be an object");
  }
  const ownReceipt = snapshotJson(receipt, "receipt", false);
  if (!Array.isArray(publicKeys)) {
    throw new VerificationError("publicKeys must be an array");
  }
  let keySnapshots;
  try {
    keySnapshots = structuredClone(publicKeys);
  } catch {
    throw new VerificationError("publicKeys must be structured-cloneable data");
  }
  const now = opts.now ?? /* @__PURE__ */ new Date();
  let nowMs;
  try {
    nowMs = Date.prototype.getTime.call(now);
  } catch {
    throw new VerificationError("now must be a valid Date");
  }
  if (!Number.isFinite(nowMs)) {
    throw new VerificationError("now must be a valid Date");
  }
  if (ownReceipt.schema_version !== SPEC_VERSION) {
    throw new VerificationError(`unsupported schema_version: ${JSON.stringify(ownReceipt.schema_version)} (want "${SPEC_VERSION}")`);
  }
  if (opts.expectedWorkspaceId !== void 0 && ownReceipt.workspace_id !== opts.expectedWorkspaceId) {
    throw new VerificationError(`workspace_id mismatch: receipt has ${JSON.stringify(ownReceipt.workspace_id)}, expected ${JSON.stringify(opts.expectedWorkspaceId)}`);
  }
  checkSchema(ownReceipt);
  const r = ownReceipt;
  const hasAction = Object.hasOwn(ownReceipt, "action");
  const hasEvent = Object.hasOwn(ownReceipt, "event");
  if (hasAction && hasEvent) {
    throw new VerificationError("receipt has both 'action' and 'event'; exactly one must be present");
  }
  if (!hasAction && !hasEvent) {
    throw new VerificationError("receipt has neither 'action' nor 'event'; exactly one must be present");
  }
  if (hasEvent) {
    const event = ownReceipt.event;
    if (typeof event !== "string") {
      throw new VerificationError("event must be a string");
    }
    if (!Object.hasOwn(EVENT_DECISIONS, event)) {
      throw new VerificationError(`event must be one of ["authorization.create","authorization.revoke","budget.settle","escalation.resolve","receipt.checkpoint"], got ${JSON.stringify(event)}`);
    }
    const expectedDecisions = EVENT_DECISIONS[event];
    if (!expectedDecisions.has(r.decision)) {
      throw new VerificationError(`event receipt with event=${JSON.stringify(event)} must have decision in ${JSON.stringify([...expectedDecisions].sort())}, got ${JSON.stringify(r.decision)}`);
    }
    if (event === "receipt.checkpoint") {
      if (r.authorization_id !== null) {
        throw new VerificationError("receipt.checkpoint must have null authorization_id");
      }
      if (r.resource !== null) {
        throw new VerificationError("receipt.checkpoint must have null resource");
      }
      checkCheckpointContext(r.context, r.issued_at);
    } else if (r.authorization_id === null) {
      throw new VerificationError(`event receipt with event=${JSON.stringify(event)} must have non-null authorization_id`);
    }
    if (AUTHORIZATION_LIFECYCLE_EVENTS.has(event) && r.resource !== null) {
      throw new VerificationError(`authorization lifecycle receipt with event=${JSON.stringify(event)} must have null resource`);
    }
    if (Object.hasOwn(ownReceipt, "policy_eval")) {
      throw new VerificationError("policy_eval must be absent on event receipts");
    }
  } else {
    const action = ownReceipt.action;
    if (typeof action !== "string") {
      throw new VerificationError("action must be a string");
    }
    if (EVENT_ONLY_DECISIONS.has(r.decision)) {
      throw new VerificationError(`decision=${JSON.stringify(r.decision)} requires an event receipt (event field), got an action receipt with action=${JSON.stringify(action)}`);
    }
    if (!ACTION_DECISIONS.has(r.decision)) {
      throw new VerificationError(`action receipt must have decision in ["allow","confirm","deny","escalate"], got ${JSON.stringify(r.decision)}`);
    }
  }
  if (r.alg !== "Ed25519") {
    throw new VerificationError(`unsupported signature alg: ${JSON.stringify(r.alg)}`);
  }
  const issuedAt = parseRFC3339(r.issued_at);
  if (issuedAt.getTime() > nowMs + MAX_FUTURE_SKEW_MS) {
    throw new VerificationError(`receipt issued in the future: ${issuedAt.toISOString()} > ${new Date(nowMs).toISOString()}`);
  }
  const { signature, ...payload } = r;
  const canonical = canonicalize2(payload);
  const key = findKey(keySnapshots, r.key_id, issuedAt);
  const fingerprint = publicKeyFingerprint(key);
  if (opts.trustedKeyFingerprints !== void 0 && !opts.trustedKeyFingerprints.has(fingerprint)) {
    throw new VerificationError(`public key fingerprint is not trusted: ${fingerprint}`);
  }
  const sigBytes = b64urlDecode(r.signature);
  const cryptoKey = await import_node_crypto.webcrypto.subtle.importKey("raw", key.publicKeyBytes, { name: "Ed25519" }, false, ["verify"]);
  const ok = await import_node_crypto.webcrypto.subtle.verify("Ed25519", cryptoKey, sigBytes, canonical);
  if (!ok) {
    throw new VerificationError("signature verification failed");
  }
}
var SEAL_PROFILE = "allowly.seal.jcs-sha256.v1";
var SEAL_ACTION = "record.seal";
var SEAL_AGENT_ID = "allowly.seal";
var SEAL_USER_ID = "allowly:seal";
var SEAL_MAX_UTF8_BYTES = 1048576;
var SEAL_MAX_DEPTH = 32;
var SealInputError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "SealInputError";
  }
};
function hashSealJson(rawJson) {
  const { bytes, text } = decodeRawSealJson(rawJson);
  if (bytes.byteLength > SEAL_MAX_UTF8_BYTES) {
    throw new SealInputError("size_limit", `record exceeds the ${SEAL_MAX_UTF8_BYTES}-byte SEAL limit`);
  }
  checkRawSealDepth(text);
  let record;
  try {
    parse(namespaceObjectKeysForValidation(text), void 0, {
      parseNumber: parseSealNumber
    });
    record = JSON.parse(text);
  } catch (error) {
    if (error instanceof SealInputError)
      throw error;
    throw new SealInputError("invalid_json", "record must be valid JSON");
  }
  return hashSealSnapshot(record);
}
function namespaceObjectKeysForValidation(text) {
  const chunks = [];
  const objectKeys = [];
  let chunkStart = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '"') {
      if (text[index] === "{")
        objectKeys.push(/* @__PURE__ */ new Set());
      else if (text[index] === "}")
        objectKeys.pop();
      index += 1;
      continue;
    }
    const tokenStart = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const char = text[index];
      if (escaped)
        escaped = false;
      else if (char === "\\")
        escaped = true;
      else if (char === '"')
        break;
      index += 1;
    }
    if (index >= text.length)
      break;
    const tokenEnd = index + 1;
    let next = tokenEnd;
    while (next < text.length && /\s/u.test(text[next]))
      next += 1;
    if (text[next] === ":") {
      try {
        const key = JSON.parse(text.slice(tokenStart, tokenEnd));
        const keys = objectKeys.at(-1);
        if (keys?.has(key)) {
          throw new SealInputError("duplicate_key", `duplicate decoded object key: ${JSON.stringify(key)}`);
        }
        keys?.add(key);
        chunks.push(text.slice(chunkStart, tokenStart), JSON.stringify(`\0${key}`));
        chunkStart = tokenEnd;
      } catch (error) {
        if (error instanceof SealInputError)
          throw error;
      }
    }
    index = tokenEnd;
  }
  if (chunks.length === 0)
    return text;
  chunks.push(text.slice(chunkStart));
  return chunks.join("");
}
function hashSealValue(record) {
  return hashSealSnapshot(record);
}
async function verifySealJson(rawJson, receipt, publicKeys, opts) {
  return verifySeal(() => hashSealJson(rawJson), receipt, publicKeys, opts);
}
async function verifySealValue(record, receipt, publicKeys, opts) {
  return verifySeal(() => hashSealValue(record), receipt, publicKeys, opts);
}
async function verifySeal(recordDigest, receipt, publicKeys, opts) {
  if (!opts || typeof opts.expectedWorkspaceId !== "string" || opts.expectedWorkspaceId.length === 0) {
    return sealResult(false, false, "receipt_verification_failed");
  }
  let ownReceipt;
  try {
    ownReceipt = snapshotJson(receipt, "receipt", false);
    await verifyReceipt(ownReceipt, publicKeys, opts);
  } catch (error) {
    if (error instanceof VerificationError) {
      return sealResult(false, false, "receipt_verification_failed");
    }
    throw error;
  }
  if (ownReceipt.action !== SEAL_ACTION || ownReceipt.decision !== "allow") {
    return sealResult(true, false, "not_seal_receipt");
  }
  if (ownReceipt.agent_id !== SEAL_AGENT_ID || ownReceipt.user_id !== SEAL_USER_ID) {
    return sealResult(true, false, "seal_identity_mismatch");
  }
  const context = ownReceipt.context;
  if (context.seal_profile !== SEAL_PROFILE) {
    return sealResult(true, false, "seal_profile_mismatch");
  }
  const expectedDigest = context.record_sha256;
  if (typeof expectedDigest !== "string" || !/^[0-9a-f]{64}$/.test(expectedDigest)) {
    return sealResult(true, false, "invalid_record_digest");
  }
  let actualDigest;
  try {
    actualDigest = recordDigest();
  } catch (error) {
    if (error instanceof SealInputError)
      return sealResult(true, false, "invalid_record");
    throw error;
  }
  const matches = (0, import_node_crypto.timingSafeEqual)(Buffer.from(actualDigest, "hex"), Buffer.from(expectedDigest, "hex"));
  return matches ? sealResult(true, true, null) : sealResult(true, false, "record_mismatch");
}
function sealResult(signatureVerified, recordMatches, failureReason) {
  return { signatureVerified, recordMatches, failureReason };
}
function decodeRawSealJson(rawJson) {
  if (typeof rawJson === "string") {
    if (!rawJson.isWellFormed()) {
      throw new SealInputError("invalid_unicode", "record contains an unpaired Unicode surrogate");
    }
    return { bytes: new TextEncoder().encode(rawJson), text: rawJson };
  }
  if (!(rawJson instanceof Uint8Array)) {
    throw new SealInputError("invalid_type", "rawJson must be a string or Uint8Array");
  }
  const bytes = new Uint8Array(rawJson);
  try {
    return { bytes, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch (error) {
    throw new SealInputError("invalid_utf8", "record must be well-formed UTF-8");
  }
}
function checkRawSealDepth(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped)
        escaped = false;
      else if (char === "\\")
        escaped = true;
      else if (char === '"')
        inString = false;
      continue;
    }
    if (char === '"')
      inString = true;
    else if (char === "[" || char === "{") {
      depth += 1;
      if (depth > SEAL_MAX_DEPTH) {
        throw new SealInputError("depth_limit", `record nesting exceeds the SEAL max depth ${SEAL_MAX_DEPTH}`);
      }
    } else if (char === "]" || char === "}")
      depth -= 1;
  }
}
function parseSealNumber(token) {
  const value = Number(token);
  if (!Number.isFinite(value)) {
    throw new SealInputError("number_overflow", "record contains a number outside binary64 range");
  }
  const significand = token.split(/[eE]/, 1)[0];
  if (value === 0 && /[1-9]/.test(significand)) {
    throw new SealInputError("number_underflow", "record number underflows binary64 to zero");
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new SealInputError("unsafe_integer", "record contains an integer outside \xB1(2^53-1)");
  }
  if (value !== 0 && !isSafeNumber(token)) {
    throw new SealInputError("number_precision", "record number loses significant digits in the RFC 8785 binary64 model");
  }
  return value;
}
function hashSealSnapshot(record) {
  const snapshot = snapshotSealValue(record);
  let canonical;
  try {
    canonical = canonicalize(snapshot);
  } catch (error) {
    throw new SealInputError("canonicalization_failed", "record cannot be canonicalized as RFC 8785");
  }
  if (canonical === void 0) {
    throw new SealInputError("canonicalization_failed", "record cannot be canonicalized as RFC 8785");
  }
  const bytes = new TextEncoder().encode(canonical);
  if (bytes.byteLength > SEAL_MAX_UTF8_BYTES) {
    throw new SealInputError("size_limit", `canonical record exceeds the ${SEAL_MAX_UTF8_BYTES}-byte SEAL limit`);
  }
  return (0, import_node_crypto.createHash)("sha256").update(bytes).digest("hex");
}
function snapshotSealValue(record) {
  validateSealTree(record);
  let snapshot;
  try {
    snapshot = structuredClone(record);
  } catch (error) {
    throw new SealInputError("unsupported_value", "record must be structured-cloneable JSON data");
  }
  validateSealTree(snapshot);
  return snapshot;
}
function validateSealTree(record) {
  const stack = [[record, 1]];
  while (stack.length > 0) {
    const [value, depth] = stack.pop();
    if (depth > SEAL_MAX_DEPTH) {
      throw new SealInputError("depth_limit", `record nesting exceeds the SEAL max depth ${SEAL_MAX_DEPTH}`);
    }
    if (value === null || typeof value === "boolean")
      continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new SealInputError("number_overflow", "record contains a non-finite number");
      }
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        throw new SealInputError("unsafe_integer", "record contains an integer outside \xB1(2^53-1)");
      }
    } else if (typeof value === "string") {
      if (!value.isWellFormed()) {
        throw new SealInputError("invalid_unicode", "record contains an unpaired Unicode surrogate");
      }
    } else if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        throw new SealInputError("unsupported_value", "record arrays must be dense without extra properties");
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (!("value" in descriptor)) {
          throw new SealInputError("unsupported_value", "record must not contain accessors");
        }
        stack.push([descriptor.value, depth + 1]);
      }
    } else if (typeof value === "object") {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new SealInputError("unsupported_value", "record objects must be plain JSON objects");
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new SealInputError("unsupported_value", "record must not contain symbol keys");
      }
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (!descriptor.enumerable || !("value" in descriptor)) {
          throw new SealInputError("unsupported_value", "record must contain enumerable data properties only");
        }
        if (!key.isWellFormed()) {
          throw new SealInputError("invalid_unicode", "record contains an unpaired Unicode surrogate");
        }
        stack.push([descriptor.value, depth + 1]);
      }
    } else {
      throw new SealInputError("unsupported_value", `record contains non-JSON type ${typeof value}`);
    }
  }
}
function checkSchema(receipt) {
  const extra = Object.keys(receipt).filter((k) => !ALL_TOP_LEVEL_FIELDS.has(k));
  if (extra.length) {
    throw new VerificationError(`unknown top-level fields: ${JSON.stringify(extra.sort())}`);
  }
  const missing = [...REQUIRED_FIELDS].filter((k) => !Object.hasOwn(receipt, k));
  if (missing.length) {
    throw new VerificationError(`missing top-level fields: ${JSON.stringify(missing.sort())}`);
  }
  const stringFields = [
    "schema_version",
    "receipt_id",
    "workspace_id",
    "issued_at",
    "decision",
    "reason",
    "user_id",
    "agent_id",
    "engine_version"
  ];
  for (const f of stringFields) {
    if (typeof receipt[f] !== "string") {
      throw new VerificationError(`${f} must be a string`);
    }
  }
  for (const f of ["resource", "authorization_id"]) {
    const v = receipt[f];
    if (v !== null && typeof v !== "string") {
      throw new VerificationError(`${f} must be string or null`);
    }
  }
  if (typeof receipt.context !== "object" || receipt.context === null || Array.isArray(receipt.context)) {
    throw new VerificationError("context must be an object");
  }
  for (const f of ["alg", "key_id", "signature"]) {
    if (typeof receipt[f] !== "string") {
      throw new VerificationError(`${f} must be a string`);
    }
  }
  const sigValue = receipt.signature;
  let sigBytes;
  try {
    sigBytes = b64urlDecode(sigValue);
  } catch {
    throw new VerificationError(`signature is not valid canonical base64url: ${JSON.stringify(sigValue)}`);
  }
  if (sigBytes.length !== 64) {
    throw new VerificationError(`signature must decode to 64 bytes (Ed25519), got ${sigBytes.length}`);
  }
  if (Object.hasOwn(receipt, "policy_eval")) {
    checkPolicyEval(receipt.policy_eval);
  }
}
function isPolicyScalar(value) {
  return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isInteger(value);
}
function isPolicyConditionValue(value) {
  if (isPolicyScalar(value)) {
    return true;
  }
  return Array.isArray(value) && value.every((item) => isPolicyScalar(item));
}
function checkExactKeys(obj, expected, prefix) {
  const expectedSet = new Set(expected);
  const extra = Object.keys(obj).filter((key) => !expectedSet.has(key));
  const missing = expected.filter((key) => !Object.hasOwn(obj, key));
  if (extra.length) {
    throw new VerificationError(`${prefix} has unknown fields: ${JSON.stringify(extra.sort())}`);
  }
  if (missing.length) {
    throw new VerificationError(`${prefix} missing fields: ${JSON.stringify(missing.sort())}`);
  }
}
function checkPolicyEval(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VerificationError("policy_eval must be an object");
  }
  const policyEval = value;
  checkExactKeys(policyEval, ["matched_condition", "field_value"], "policy_eval");
  const matched = policyEval.matched_condition;
  if (matched !== null) {
    if (typeof matched !== "object" || Array.isArray(matched)) {
      throw new VerificationError("policy_eval.matched_condition must be an object or null");
    }
    const condition = matched;
    checkExactKeys(condition, ["field", "op", "value"], "policy_eval.matched_condition");
    if (typeof condition.field !== "string") {
      throw new VerificationError("policy_eval.matched_condition.field must be a string");
    }
    if (typeof condition.op !== "string") {
      throw new VerificationError("policy_eval.matched_condition.op must be a string");
    }
    if (!isPolicyConditionValue(condition.value)) {
      throw new VerificationError("policy_eval.matched_condition.value must be string, integer, boolean, null, or an array of those");
    }
  }
  if (!isPolicyScalar(policyEval.field_value)) {
    throw new VerificationError("policy_eval.field_value must be string, integer, boolean, or null");
  }
}
var CHECKPOINT_ROOT_RE = /^sha256:[0-9a-f]{64}$/;
var CHECKPOINT_CONTEXT_FIELDS = [
  "period_start",
  "period_end",
  "receipt_count",
  "merkle_root",
  "previous_checkpoint_id",
  "previous_merkle_root"
];
function checkCheckpointContext(value, issuedAt) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VerificationError("receipt.checkpoint context must be an object");
  }
  const context = value;
  checkExactKeys(context, CHECKPOINT_CONTEXT_FIELDS, "receipt.checkpoint context");
  const periodStart = parseRFC3339(context.period_start);
  const periodEnd = parseRFC3339(context.period_end);
  const checkpointAt = parseRFC3339(issuedAt);
  if (periodEnd <= periodStart) {
    throw new VerificationError("receipt.checkpoint period_end must be after period_start");
  }
  if (!String(context.period_start).endsWith("T00:00:00.000Z") || periodEnd.getTime() - periodStart.getTime() !== 24 * 60 * 60 * 1e3) {
    throw new VerificationError("receipt.checkpoint period must be one UTC calendar day");
  }
  if (checkpointAt < periodEnd) {
    throw new VerificationError("receipt.checkpoint issued_at must be at or after period_end");
  }
  if (!Number.isSafeInteger(context.receipt_count) || context.receipt_count < 0) {
    throw new VerificationError("receipt.checkpoint receipt_count must be a non-negative integer");
  }
  if (typeof context.merkle_root !== "string" || !CHECKPOINT_ROOT_RE.test(context.merkle_root)) {
    throw new VerificationError("receipt.checkpoint merkle_root must be sha256:<64 lowercase hex>");
  }
  const previousId = context.previous_checkpoint_id;
  const previousRoot = context.previous_merkle_root;
  if (previousId === null !== (previousRoot === null)) {
    throw new VerificationError("receipt.checkpoint previous id and root must both be null or strings");
  }
  if (previousId !== null && typeof previousId !== "string") {
    throw new VerificationError("receipt.checkpoint previous_checkpoint_id must be string or null");
  }
  if (previousRoot !== null && (typeof previousRoot !== "string" || !CHECKPOINT_ROOT_RE.test(previousRoot))) {
    throw new VerificationError("receipt.checkpoint previous_merkle_root must be sha256:<64 lowercase hex> or null");
  }
}
var RFC3339_RE = /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
function parseRFC3339(s) {
  if (typeof s !== "string" || !RFC3339_RE.test(s)) {
    throw new VerificationError(`timestamp must be UTC millisecond precision YYYY-MM-DDTHH:MM:SS.sssZ, got ${JSON.stringify(s)}`);
  }
  const d = new Date(s);
  if (isNaN(d.getTime()) || d.toISOString() !== s) {
    throw new VerificationError(`not a real calendar date/time: ${s}`);
  }
  return d;
}
function findKey(keys, keyId, issuedAt) {
  for (const k of keys) {
    if (typeof k !== "object" || k === null) {
      throw new VerificationError("publicKeys entries must be objects");
    }
    if (k.keyId !== keyId)
      continue;
    if (k.alg !== "Ed25519") {
      throw new VerificationError(`unsupported public key alg: ${JSON.stringify(k.alg)}`);
    }
    if (!(k.publicKeyBytes instanceof Uint8Array) || k.publicKeyBytes.length !== 32) {
      throw new VerificationError("selected Ed25519 public key must contain 32 raw bytes");
    }
    if (!(k.activeFrom instanceof Date) || !Number.isFinite(k.activeFrom.getTime())) {
      throw new VerificationError("selected public key activeFrom must be a valid Date");
    }
    if (k.activeUntil !== null && (!(k.activeUntil instanceof Date) || !Number.isFinite(k.activeUntil.getTime()))) {
      throw new VerificationError("selected public key activeUntil must be a valid Date or null");
    }
    if (k.activeUntil !== null && k.activeUntil <= k.activeFrom) {
      throw new VerificationError("selected public key active window is empty");
    }
    if (issuedAt < k.activeFrom) {
      throw new VerificationError(`key ${JSON.stringify(keyId)} not yet active at issued_at`);
    }
    if (k.activeUntil !== null && issuedAt >= k.activeUntil) {
      throw new VerificationError(`key ${JSON.stringify(keyId)} retired before issued_at`);
    }
    return {
      keyId: k.keyId,
      alg: k.alg,
      publicKeyBytes: new Uint8Array(k.publicKeyBytes),
      activeFrom: new Date(k.activeFrom.getTime()),
      activeUntil: k.activeUntil === null ? null : new Date(k.activeUntil.getTime())
    };
  }
  throw new VerificationError(`no public key found for key_id=${JSON.stringify(keyId)}`);
}
function loadKeysFromJson(doc) {
  if (typeof doc !== "object" || doc === null || !Object.hasOwn(doc, "workspace_id") || typeof doc.workspace_id !== "string" || doc.workspace_id.length === 0 || !Object.hasOwn(doc, "keys") || !Array.isArray(doc.keys)) {
    throw new VerificationError("keys document must be an object with a non-empty 'workspace_id' and a 'keys' array");
  }
  const seenIds = /* @__PURE__ */ new Set();
  const seenPubs = /* @__PURE__ */ new Set();
  return doc.keys.map((k, i) => {
    if (typeof k !== "object" || k === null) {
      throw new VerificationError(`keys[${i}] must be an object`);
    }
    for (const field of ["key_id", "alg", "public_key", "active_from"]) {
      if (!Object.hasOwn(k, field) || typeof k[field] !== "string") {
        throw new VerificationError(`keys[${i}].${field} must be a string`);
      }
    }
    if (k.alg !== "Ed25519") {
      throw new VerificationError(`keys[${i}].alg must be "Ed25519"`);
    }
    if (!Object.hasOwn(k, "active_until") || k.active_until !== null && typeof k.active_until !== "string") {
      throw new VerificationError(`keys[${i}].active_until must be a string or null`);
    }
    if (seenIds.has(k.key_id)) {
      throw new VerificationError(`duplicate key_id in keys document: ${JSON.stringify(k.key_id)}`);
    }
    if (seenPubs.has(k.public_key)) {
      throw new VerificationError(`duplicate public key in keys document: ${JSON.stringify(k.key_id)}`);
    }
    seenIds.add(k.key_id);
    seenPubs.add(k.public_key);
    const pub = b64urlDecode(k.public_key);
    if (pub.length !== 32) {
      throw new VerificationError(`keys[${i}].public_key must decode to 32 bytes, got ${pub.length}`);
    }
    const key = {
      keyId: k.key_id,
      alg: "Ed25519",
      publicKeyBytes: pub,
      activeFrom: parseRFC3339(k.active_from),
      activeUntil: k.active_until === null ? null : parseRFC3339(k.active_until)
    };
    if (Object.hasOwn(k, "public_key_fingerprint") && k.public_key_fingerprint !== publicKeyFingerprint(key)) {
      throw new VerificationError(`keys[${i}].public_key_fingerprint does not match public_key`);
    }
    return key;
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SEAL_MAX_DEPTH,
  SEAL_MAX_UTF8_BYTES,
  SEAL_PROFILE,
  SealInputError,
  hashSealJson,
  hashSealValue,
  loadKeysFromJson,
  publicKeyFingerprint,
  verifySealJson,
  verifySealValue
});
