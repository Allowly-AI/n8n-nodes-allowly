/* Bundled from local unpublished @allowly/verifier 5.0.0; wire 5 only. See VERIFIER_PROVENANCE.json. */
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
  decodeReceipt: () => decodeReceipt,
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

// ../allowly-receipt-format/verifiers/typescript/node_modules/jose/dist/webapi/lib/buffer_utils.js
var encoder = new TextEncoder();
var decoder = new TextDecoder();
var strictDecoder = new TextDecoder("utf-8", { fatal: true });
var MAX_INT32 = 2 ** 32;
function concat(...buffers) {
  const size = buffers.reduce((acc, { length }) => acc + length, 0), buf = new Uint8Array(size);
  let i = 0;
  for (const buffer of buffers)
    buf.set(buffer, i), i += buffer.length;
  return buf;
}
var NON_ASCII = /[^\x00-\x7f]/;
function encode(string) {
  if (typeof string == "string" && string.length >= 128) {
    if (NON_ASCII.test(string))
      throw new TypeError("non-ASCII string encountered in encode()");
    return encoder.encode(string);
  }
  const bytes = new Uint8Array(string.length);
  for (let i = 0; i < string.length; i++) {
    const code = string.charCodeAt(i);
    if (code > 127)
      throw new TypeError("non-ASCII string encountered in encode()");
    bytes[i] = code;
  }
  return bytes;
}
function encodeBase64(input, url = false) {
  if (Uint8Array.prototype.toBase64)
    return input.toBase64({ alphabet: url ? "base64url" : "base64", omitPadding: url });
  const CHUNK_SIZE = 32768, arr = [];
  for (let i = 0; i < input.length; i += CHUNK_SIZE)
    arr.push(String.fromCharCode.apply(null, input.subarray(i, i + CHUNK_SIZE)));
  const encoded = btoa(arr.join(""));
  return url ? encoded.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_") : encoded;
}
function decodeBase64(encoded, url = false) {
  if (Uint8Array.fromBase64)
    return Uint8Array.fromBase64(encoded, { alphabet: url ? "base64url" : "base64" });
  if (url) {
    if (encoded.includes("+") || encoded.includes("/"))
      throw new TypeError("Invalid base64url");
    encoded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  }
  const binary = atob(encoded), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ../allowly-receipt-format/verifiers/typescript/node_modules/jose/dist/webapi/util/errors.js
var JOSEError = class extends Error {
  static code = "ERR_JOSE_GENERIC";
  code = "ERR_JOSE_GENERIC";
  constructor(message2, options) {
    super(message2, options), this.name = this.constructor.name, Error.captureStackTrace?.(this, this.constructor);
  }
};
var JOSEAlgNotAllowed = class extends JOSEError {
  static code = "ERR_JOSE_ALG_NOT_ALLOWED";
  code = "ERR_JOSE_ALG_NOT_ALLOWED";
};
var JOSENotSupported = class extends JOSEError {
  static code = "ERR_JOSE_NOT_SUPPORTED";
  code = "ERR_JOSE_NOT_SUPPORTED";
};
var JWSInvalid = class extends JOSEError {
  static code = "ERR_JWS_INVALID";
  code = "ERR_JWS_INVALID";
};
var JWSSignatureVerificationFailed = class extends JOSEError {
  static code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
  code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
  constructor(message2 = "signature verification failed", options) {
    super(message2, options);
  }
};

// ../allowly-receipt-format/verifiers/typescript/node_modules/jose/dist/webapi/util/base64url.js
var base64url_exports = {};
__export(base64url_exports, {
  decode: () => decode,
  encode: () => encode2
});
var invalid = "The input to be decoded is not correctly encoded.";
function decode(input) {
  try {
    return decodeBase64(typeof input == "string" ? input : decoder.decode(input), true);
  } catch (cause) {
    throw new TypeError(invalid, { cause });
  }
}
function encode2(input) {
  return encodeBase64(typeof input == "string" ? encoder.encode(input) : input, true);
}

// ../allowly-receipt-format/verifiers/typescript/node_modules/jose/dist/webapi/lib/validate.js
function isObject2(input) {
  if (typeof input != "object" || input === null || Object.prototype.toString.call(input) !== "[object Object]")
    return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}
function isDisjoint(...headers) {
  const parameters = /* @__PURE__ */ new Set();
  for (const header of headers)
    if (header)
      for (const parameter of Object.keys(header)) {
        if (parameters.has(parameter))
          return false;
        parameters.add(parameter);
      }
  return true;
}
function decodeBase64url(value, label, ErrorClass) {
  try {
    return decode(value);
  } catch {
    throw new ErrorClass(`Failed to base64url decode the ${label}`);
  }
}
function encodeBase64url(value, label, ErrorClass) {
  try {
    return encode(value);
  } catch {
    throw new ErrorClass(`The ${label} is not a valid base64url string`);
  }
}
function parseJoseHeader(b64, ErrorClass, message2) {
  let parsed;
  try {
    parsed = JSON.parse(strictDecoder.decode(decode(b64)));
  } catch {
    throw new ErrorClass(message2);
  }
  if (!isObject2(parsed))
    throw new ErrorClass(message2);
  return parsed;
}
var JWS_RECOGNIZED = { __proto__: null, b64: true };
function validateAlgorithms(option, algorithms) {
  if (algorithms !== void 0 && (!Array.isArray(algorithms) || algorithms.some((s) => typeof s != "string")))
    throw new TypeError(`"${option}" option must be an array of strings`);
  return algorithms === void 0 ? void 0 : new Set(algorithms);
}
function validateCrit(Err, recognizedDefault, recognizedOption, protectedHeader, joseHeader) {
  if (joseHeader.crit !== void 0 && protectedHeader?.crit === void 0)
    throw new Err('"crit" (Critical) Header Parameter MUST be integrity protected');
  if (!protectedHeader || protectedHeader.crit === void 0)
    return [];
  if (!Array.isArray(protectedHeader.crit) || protectedHeader.crit.length === 0 || protectedHeader.crit.some((input) => typeof input != "string" || input.length === 0))
    throw new Err('"crit" (Critical) Header Parameter MUST be an array of non-empty strings when present');
  const recognized = recognizedOption === void 0 ? recognizedDefault : { __proto__: null, ...recognizedOption, ...recognizedDefault };
  for (const parameter of protectedHeader.crit) {
    if (!(parameter in recognized))
      throw new JOSENotSupported(`Extension Header Parameter "${parameter}" is not recognized`);
    if (!Object.hasOwn(joseHeader, parameter) || joseHeader[parameter] === void 0)
      throw new Err(`Extension Header Parameter "${parameter}" is missing`);
    if (recognized[parameter] && (!Object.hasOwn(protectedHeader, parameter) || protectedHeader[parameter] === void 0))
      throw new Err(`Extension Header Parameter "${parameter}" MUST be integrity protected`);
  }
  return protectedHeader.crit;
}
function validateB64(protectedHeader, extensions) {
  if (extensions.includes("b64")) {
    const b64 = protectedHeader.b64;
    if (typeof b64 != "boolean")
      throw new JWSInvalid('The "b64" (base64url-encode payload) Header Parameter must be a boolean');
    return b64;
  }
  return true;
}

// ../allowly-receipt-format/verifiers/typescript/node_modules/jose/dist/webapi/lib/key.js
var tag = (key) => key[Symbol.toStringTag];
var jwkMatchesOp = (entry, key, usage) => {
  const { alg } = entry;
  if (key.use !== void 0) {
    const expected = usage === "sign" || usage === "verify" ? "sig" : "enc";
    if (key.use !== expected)
      throw new TypeError(`Invalid key for this operation, its "use" must be "${expected}" when present`);
  }
  if (key.alg !== void 0 && key.alg !== alg)
    throw new TypeError(`Invalid key for this operation, its "alg" must be "${alg}" when present`);
  if (Array.isArray(key.key_ops)) {
    const expectedKeyOp = usage === "encrypt" || usage === "decrypt" ? entry.ops?.[usage === "encrypt" ? 0 : 1] : usage;
    if (expectedKeyOp && !key.key_ops.includes(expectedKeyOp))
      throw new TypeError(`Invalid key for this operation, its "key_ops" must include "${expectedKeyOp}" when present`);
  }
};
async function prepareKey(entry, key, usage) {
  const { alg, secret } = entry, privateKey = usage === "decrypt" || usage === "sign";
  if (secret && key instanceof Uint8Array)
    return key;
  let normalized, keyObject;
  if (isObject2(key)) {
    if (normalized = normalizeJwk(key), typeof normalized.kty != "string")
      throw invalidKeyType(alg, key, secret);
    if (!(secret ? normalized.kty === "oct" && typeof normalized.k == "string" : normalized.kty !== "oct" && (privateKey ? normalized.kty === "AKP" && typeof normalized.priv == "string" || typeof normalized.d == "string" : normalized.d === void 0 && normalized.priv === void 0)))
      throw new TypeError(secret ? 'JSON Web Key for symmetric algorithms must have JWK "kty" (Key Type) equal to "oct" and the JWK "k" (Key Value) present' : `JSON Web Key for this operation must be a ${privateKey ? "private" : "public"} JWK`);
    if (jwkMatchesOp(entry, normalized, usage), normalized.kty === "oct")
      return decode(normalized.k);
    if (!Object.isFrozen(key)) {
      const { key_ops } = key;
      Array.isArray(key_ops) && Object.freeze(key_ops), Object.freeze(key);
    }
  } else {
    if (!isKeyLike(key))
      throw invalidKeyType(alg, key, secret);
    const expectedType = secret ? "secret" : privateKey ? "private" : "public";
    if (key.type !== expectedType && (secret || ["secret", "public", "private"].includes(key.type)))
      throw new TypeError(`${tag(key)} instances must be of type "${expectedType}" for the ${alg} algorithm`);
    if (isCryptoKey(key))
      return key;
    if (keyObject = key, keyObject.type === "secret")
      return keyObject.export();
  }
  cache ||= /* @__PURE__ */ new WeakMap();
  const cacheKey = key;
  let cached = cache.get(cacheKey);
  if (cached?.[alg])
    return cached[alg];
  if (cached || cache.set(cacheKey, cached = {}), keyObject && typeof keyObject.toCryptoKey == "function") {
    const isPublic = keyObject.type === "public", crv = nist[keyObject.asymmetricKeyDetails?.namedCurve], params = entry.resolve?.({ crv, asymmetricKeyType: keyObject.asymmetricKeyType }) ?? entry.subtle;
    return cached[alg] = keyObject.toCryptoKey(params, isPublic, entry.usages[isPublic ? 0 : 1]);
  }
  return normalized ??= keyObject.export({ format: "jwk" }), normalized.alg = alg, cached[alg] = await jwkToKey(entry, normalized);
}
var cache;
var nist = {
  __proto__: null,
  prime256v1: "P-256",
  secp384r1: "P-384",
  secp521r1: "P-521"
};
var isCryptoKey = (key) => {
  if (key?.[Symbol.toStringTag] === "CryptoKey")
    return true;
  try {
    return key instanceof CryptoKey;
  } catch {
    return false;
  }
};
var isKeyObject = (key) => key?.[Symbol.toStringTag] === "KeyObject";
var isKeyLike = (key) => isCryptoKey(key) || isKeyObject(key);
function message(msg, actual, ...types) {
  if (types.length > 2) {
    const last = types.pop();
    msg += `one of type ${types.join(", ")}, or ${last}.`;
  } else types.length === 2 ? msg += `one of type ${types[0]} or ${types[1]}.` : msg += `of type ${types[0]}.`;
  return actual == null ? msg += ` Received ${actual}` : typeof actual == "function" && actual.name ? msg += ` Received function ${actual.name}` : typeof actual == "object" && actual != null && actual.constructor?.name && (msg += ` Received an instance of ${actual.constructor.name}`), msg;
}
function invalidKeyType(alg, actual, secret) {
  const types = ["CryptoKey", "KeyObject", "JSON Web Key"];
  return secret && types.push("Uint8Array"), new TypeError(message(`Key for the ${alg} algorithm must be `, actual, ...types));
}
var unusable = (name, prop = "algorithm.name") => new TypeError(`CryptoKey does not support this operation, its ${prop} must be ${name}`);
function checkUsage(key, usage) {
  if (usage && !key.usages.includes(usage))
    throw new TypeError(`CryptoKey does not support this operation, its usages must include ${usage}.`);
}
function checkModulusLength(alg, key) {
  const { modulusLength } = key.algorithm;
  if (typeof modulusLength != "number" || modulusLength < 2048)
    throw new TypeError(`${alg} requires key modulusLength to be 2048 bits or larger`);
}
function checkCryptoKey(key, expected, usage) {
  const algorithm = key.algorithm;
  if (algorithm.name !== expected.name)
    throw unusable(expected.name);
  if (expected.hash && algorithm.hash?.name !== expected.hash)
    throw unusable(expected.hash, "algorithm.hash");
  if (expected.namedCurve && algorithm.namedCurve !== expected.namedCurve)
    throw unusable(expected.namedCurve, "algorithm.namedCurve");
  if (expected.length !== void 0 && algorithm.length !== expected.length)
    throw unusable(expected.length, "algorithm.length");
  checkUsage(key, usage);
}
function snapshotJwk(jwk) {
  return { __proto__: null, ...jwk };
}
function normalizeJwk(jwk) {
  const normalized = snapshotJwk(jwk);
  if (normalized.ext !== void 0 && typeof normalized.ext != "boolean")
    throw new TypeError('"ext" (Extractable) Parameter must be a boolean');
  if (normalized.key_ops !== void 0) {
    const value = normalized.key_ops, keyOps = Array.isArray(value) ? [...value] : void 0;
    if (!keyOps || keyOps.some((operation) => typeof operation != "string") || new Set(keyOps).size !== keyOps.length)
      throw new TypeError('"key_ops" (Key Operations) Parameter must be an array of unique strings');
    normalized.key_ops = keyOps;
  }
  return normalized;
}
function validateExtractableOption(extractable) {
  if (extractable !== void 0 && typeof extractable != "boolean")
    throw new TypeError('"extractable" option must be a boolean');
  return extractable;
}
async function jwkToKey(entry, jwk, extractable) {
  if (!entry.kty.includes(jwk.kty))
    throw new JOSENotSupported('Invalid or unsupported JWK "alg" (Algorithm) Parameter value');
  const algorithm = entry.resolve?.({ kty: jwk.kty, crv: jwk.crv }) ?? entry.subtle, isPrivate = !!(jwk.d || jwk.priv), keyData = { ...jwk, ext: extractable ?? jwk.ext };
  return keyData.kty !== "AKP" && delete keyData.alg, delete keyData.use, crypto.subtle.importKey("jwk", keyData, algorithm, keyData.ext ?? !isPrivate, jwk.key_ops ?? entry.usages[isPrivate ? 1 : 0]);
}
async function rawKey(key, expected, usage, extractable = false) {
  return key instanceof Uint8Array && (key = await crypto.subtle.importKey("raw", key, expected, extractable, [usage])), checkCryptoKey(key, expected, usage), key;
}

// ../allowly-receipt-format/verifiers/typescript/node_modules/jose/dist/webapi/lib/key_descriptor.js
function table(entries) {
  const out = { __proto__: null };
  for (const alg in entries)
    out[alg] = { ...entries[alg], alg };
  return out;
}

// ../allowly-receipt-format/verifiers/typescript/node_modules/jose/dist/webapi/lib/jwe_algorithms.js
var wrap = [
  ["encrypt", "wrapKey"],
  ["decrypt", "unwrapKey"]
];
var derive = [[], ["deriveBits"]];
var none = [[], []];
function rsaes(bits) {
  return {
    kty: ["RSA"],
    mode: "key-encryption",
    subtle: { name: "RSA-OAEP", hash: `SHA-${bits}` },
    usages: wrap,
    ops: ["wrapKey", "unwrapKey"]
  };
}
function ecdh(mode) {
  return {
    kty: ["EC", "OKP"],
    mode,
    subtle: { name: "ECDH" },
    resolve: ({ kty, crv, asymmetricKeyType }) => {
      if (crv === "X25519" || asymmetricKeyType === "x25519")
        return { name: "X25519" };
      if (kty === "OKP")
        throw new JOSENotSupported('Invalid or unsupported JWK "alg" (Algorithm) Parameter value');
      return { name: "ECDH", namedCurve: crv };
    },
    usages: derive,
    ops: [void 0, "deriveBits"]
  };
}
function aeskw(bits, gcm = false) {
  return {
    kty: ["oct"],
    mode: "key-wrapping",
    secret: true,
    subtle: { name: gcm ? "AES-GCM" : "AES-KW", length: bits },
    usages: none,
    ops: gcm ? ["encrypt", "decrypt"] : ["wrapKey", "unwrapKey"]
  };
}
function pbes2() {
  return {
    kty: ["oct"],
    mode: "key-wrapping",
    secret: true,
    subtle: { name: "PBKDF2" },
    usages: none,
    ops: ["deriveBits", "deriveBits"]
  };
}
var JWE = table({
  dir: {
    kty: ["oct"],
    mode: "direct-encryption",
    secret: true,
    subtle: { name: "AES-GCM" },
    usages: none,
    ops: ["encrypt", "decrypt"]
  },
  "RSA-OAEP": rsaes(1),
  "RSA-OAEP-256": rsaes(256),
  "RSA-OAEP-384": rsaes(384),
  "RSA-OAEP-512": rsaes(512),
  "ECDH-ES": ecdh("direct-key-agreement"),
  "ECDH-ES+A128KW": ecdh("key-agreement-with-key-wrapping"),
  "ECDH-ES+A192KW": ecdh("key-agreement-with-key-wrapping"),
  "ECDH-ES+A256KW": ecdh("key-agreement-with-key-wrapping"),
  A128KW: aeskw(128),
  A192KW: aeskw(192),
  A256KW: aeskw(256),
  A128GCMKW: aeskw(128, true),
  A192GCMKW: aeskw(192, true),
  A256GCMKW: aeskw(256, true),
  "PBES2-HS256+A128KW": pbes2(),
  "PBES2-HS384+A192KW": pbes2(),
  "PBES2-HS512+A256KW": pbes2()
});
var contentOps = ["encrypt", "decrypt"];
function contentEncryption(bits, cbc = false) {
  return {
    kty: ["oct"],
    secret: true,
    subtle: { name: cbc ? "AES-CBC" : "AES-GCM", length: bits },
    usages: none,
    ops: contentOps,
    cekBits: bits,
    ivBits: cbc ? 128 : 96,
    cbc
  };
}
var ENC = table({
  A128GCM: contentEncryption(128),
  A192GCM: contentEncryption(192),
  A256GCM: contentEncryption(256),
  "A128CBC-HS256": contentEncryption(256, true),
  "A192CBC-HS384": contentEncryption(384, true),
  "A256CBC-HS512": contentEncryption(512, true)
});

// ../allowly-receipt-format/verifiers/typescript/node_modules/jose/dist/webapi/lib/jws_algorithms.js
var sig = [["verify"], ["sign"]];
function hmac(bits) {
  const subtle = { name: "HMAC", hash: `SHA-${bits}` };
  return { kty: ["oct"], secret: true, subtle, signing: subtle, usages: sig };
}
function rsa(bits, saltLength) {
  const subtle = { name: saltLength ? "RSA-PSS" : "RSASSA-PKCS1-v1_5", hash: `SHA-${bits}` };
  return {
    kty: ["RSA"],
    subtle,
    signing: saltLength ? { ...subtle, saltLength } : subtle,
    usages: sig,
    minRsaBits: 2048
  };
}
function ecdsa(crv, bits) {
  return {
    kty: ["EC"],
    crv,
    subtle: { name: "ECDSA", namedCurve: crv },
    signing: { name: "ECDSA", hash: `SHA-${bits}` },
    usages: sig
  };
}
function eddsa() {
  const subtle = { name: "Ed25519" };
  return {
    kty: ["OKP"],
    crv: "Ed25519",
    subtle,
    signing: subtle,
    usages: sig
  };
}
function mldsa(bits) {
  const subtle = { name: `ML-DSA-${bits}` };
  return {
    kty: ["AKP"],
    subtle,
    signing: subtle,
    usages: sig
  };
}
var JWS = table({
  HS256: hmac(256),
  HS384: hmac(384),
  HS512: hmac(512),
  RS256: rsa(256),
  RS384: rsa(384),
  RS512: rsa(512),
  PS256: rsa(256, 32),
  PS384: rsa(384, 48),
  PS512: rsa(512, 64),
  ES256: ecdsa("P-256", 256),
  ES384: ecdsa("P-384", 384),
  ES512: ecdsa("P-521", 512),
  EdDSA: eddsa(),
  Ed25519: eddsa(),
  "ML-DSA-44": mldsa(44),
  "ML-DSA-65": mldsa(65),
  "ML-DSA-87": mldsa(87)
});
function jwsAlgorithm(alg) {
  const entry = typeof alg == "string" ? JWS[alg] : void 0;
  if (!entry)
    throw new JOSENotSupported(`alg ${alg} is not supported either by JOSE or your javascript runtime`);
  return entry;
}

// ../allowly-receipt-format/verifiers/typescript/node_modules/jose/dist/webapi/lib/jws_verify.js
function prepareVerify(options) {
  return [options && validateAlgorithms("algorithms", options.algorithms), options?.crit];
}
function parseProtectedHeader(encodedProtected) {
  return encodedProtected === void 0 ? {} : parseJoseHeader(encodedProtected, JWSInvalid, "JWS Protected Header is invalid");
}
function encodeCompactUnencodedPayload(payload) {
  try {
    return encode(payload);
  } catch {
    throw new JWSInvalid("JWS Compact Serialization payload must use only ASCII characters");
  }
}
async function verifySignature(jws, shared, key, encodeUnencodedPayload, parsedProtected) {
  const { protected: encodedProtected, header, payload: inputPayload } = jws, parsedProt = parsedProtected ?? parseProtectedHeader(encodedProtected);
  if (!isDisjoint(parsedProt, header))
    throw new JWSInvalid("JWS Protected and JWS Unprotected Header Parameter names must be disjoint");
  const joseHeader = { ...parsedProt, ...header }, b64 = validateB64(parsedProt, validateCrit(JWSInvalid, JWS_RECOGNIZED, shared[1], parsedProt, joseHeader)), { alg } = joseHeader;
  if (typeof alg != "string" || !alg)
    throw new JWSInvalid('JWS "alg" (Algorithm) Header Parameter missing or invalid');
  if (shared[0] && !shared[0].has(alg))
    throw new JOSEAlgNotAllowed('"alg" (Algorithm) Header Parameter value not allowed');
  if (b64) {
    if (typeof inputPayload != "string")
      throw new JWSInvalid("JWS Payload must be a string");
  } else if (typeof inputPayload != "string" && !(inputPayload instanceof Uint8Array))
    throw new JWSInvalid("JWS Payload must be a string or an Uint8Array instance");
  const signingPayload = b64 || typeof inputPayload != "string" ? inputPayload : encodeUnencodedPayload(inputPayload);
  let resolvedKey = false;
  typeof key == "function" && (key = await key(parsedProt, jws), resolvedKey = true);
  const entry = jwsAlgorithm(alg), data = concat(encodedProtected !== void 0 ? encode(encodedProtected) : new Uint8Array(), encode("."), typeof signingPayload == "string" ? shared[2] ??= encodeBase64url(signingPayload, "payload", JWSInvalid) : signingPayload), signature = decodeBase64url(jws.signature, "signature", JWSInvalid), k = await prepareKey(entry, key, "verify"), cryptoKey = await rawKey(k, entry.subtle, "verify");
  entry.minRsaBits && checkModulusLength(entry.alg, cryptoKey);
  let verified = false;
  try {
    verified = await crypto.subtle.verify(entry.signing, cryptoKey, signature, data);
  } catch {
  }
  if (!verified)
    throw new JWSSignatureVerificationFailed();
  const result = { payload: typeof signingPayload == "string" ? decodeBase64url(signingPayload, "payload", JWSInvalid) : signingPayload };
  return encodedProtected !== void 0 && (result.protectedHeader = parsedProt), header !== void 0 && (result.unprotectedHeader = header), resolvedKey ? [{ ...result, key: k }, b64] : [result, b64];
}
async function verifyCompact(jws, shared, key) {
  if (jws instanceof Uint8Array && (jws = decoder.decode(jws)), typeof jws != "string")
    throw new JWSInvalid("Compact JWS must be a string or Uint8Array");
  const { 0: protectedHeader, 1: payload, 2: signature, length } = jws.split(".");
  if (length !== 3)
    throw new JWSInvalid("Invalid Compact JWS");
  return verifySignature({ payload, protected: protectedHeader, signature }, shared, key, encodeCompactUnencodedPayload);
}

// ../allowly-receipt-format/verifiers/typescript/node_modules/jose/dist/webapi/jws/compact/verify.js
async function compactVerify(jws, key, options) {
  const [result] = await verifyCompact(jws, prepareVerify(options), key);
  return result;
}

// ../allowly-receipt-format/verifiers/typescript/node_modules/jose/dist/webapi/lib/key_algorithm.js
function unsupportedAlg(source = 'JWK "alg" (Algorithm) Parameter') {
  throw new JOSENotSupported(`Invalid or unsupported ${source} value`);
}
function keyAlgorithm(alg, source) {
  return (typeof alg == "string" ? JWS[alg] ?? JWE[alg] : void 0) ?? unsupportedAlg(source);
}

// ../allowly-receipt-format/verifiers/typescript/node_modules/jose/dist/webapi/key/import.js
async function importJWK(jwk, alg, options) {
  if (!isObject2(jwk))
    throw new TypeError("JWK must be an object");
  const normalized = normalizeJwk(jwk), extractable = validateExtractableOption(options?.extractable), { alg: jwkAlg } = normalized;
  if (alg ??= jwkAlg, normalized.kty !== "oct" && !alg)
    throw new TypeError('"alg" argument is required when "jwk.alg" is not present');
  switch (normalized.kty) {
    case "oct":
      if (typeof normalized.k != "string")
        throw new TypeError('missing "k" (Key Value) Parameter value');
      return decode(normalized.k);
    case "AKP": {
      if (typeof jwkAlg != "string" || !jwkAlg)
        throw new TypeError('missing "alg" (Algorithm) Parameter value');
      if (alg !== jwkAlg)
        throw new TypeError("JWK alg and alg option value mismatch");
      return jwkToKey(keyAlgorithm(alg), normalized, extractable);
    }
    case "RSA":
    case "EC":
    case "OKP":
      return jwkToKey(keyAlgorithm(alg), normalized, extractable);
    default:
      throw new JOSENotSupported('Unsupported "kty" (Key Type) Parameter value');
  }
}

// ../allowly-receipt-format/verifiers/typescript/dist/verifier.js
var SPEC_VERSION = "5";
var ACTION_DECISIONS = /* @__PURE__ */ new Set(["allow", "deny", "confirm", "escalate"]);
var EVENT_DECISIONS = {
  "authorization.create": /* @__PURE__ */ new Set(["authorization_granted"]),
  "authorization.revoke": /* @__PURE__ */ new Set(["authorization_revoked"]),
  "budget.settle": /* @__PURE__ */ new Set(["budget_settled"]),
  "confirmation.resolve": /* @__PURE__ */ new Set(["confirmation_approved", "confirmation_rejected"]),
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
  "policy_ref",
  "engine_version"
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
  constructor(message2) {
    super(message2);
    this.name = "VerificationError";
  }
};
function publicKeyFingerprint(key) {
  return "sha256:" + (0, import_node_crypto.createHash)("sha256").update(key.publicKeyBytes).digest("hex");
}
function jwsParts(receipt) {
  const envelope = snapshotJson(receipt, "receipt");
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope))
    throw new VerificationError("receipt must be an object");
  checkExactKeys(envelope, ["protected", "payload", "signature"], "JWS envelope");
  if (Object.values(envelope).some((value) => typeof value !== "string"))
    throw new VerificationError("JWS segments must be strings");
  const wire = envelope;
  if (wire.protected.length + wire.payload.length + wire.signature.length > 8 * 1024 * 1024)
    throw new VerificationError("JWS exceeds size limit");
  const parse2 = (encoded) => {
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b64urlDecode(encoded));
      parse(namespaceObjectKeysForValidation(text), void 0, { parseNumber: (token) => {
        if (!/^-?(?:0|[1-9][0-9]*)$/.test(token))
          throw new VerificationError("receipts must not contain non-integer numbers");
        const number = Number(token);
        if (!Number.isSafeInteger(number))
          throw new VerificationError("integer exceeds the safe range \xB1(2^53-1)");
        return number;
      } });
      const value = JSON.parse(text);
      validateTree(value);
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new VerificationError("JWS JSON must be an object");
      return value;
    } catch (error) {
      if (error instanceof VerificationError)
        throw error;
      throw new VerificationError(`invalid JWS strict UTF-8 JSON: ${error instanceof Error ? error.message : "invalid JSON"}`);
    }
  };
  const header = parse2(wire.protected);
  checkExactKeys(header, ["alg", "kid", "typ"], "JWS protected header");
  if (header.alg !== "EdDSA" || header.typ !== "allowly-receipt+jws")
    throw new VerificationError("unsupported JWS algorithm or type");
  if (typeof header.kid !== "string" || !header.kid)
    throw new VerificationError("JWS kid must be a nonempty string");
  if (b64urlDecode(wire.signature).length !== 64)
    throw new VerificationError("signature must decode to 64 bytes (Ed25519)");
  const payload = parse2(wire.payload);
  if (payload.schema_version !== SPEC_VERSION)
    throw new VerificationError(`unsupported schema_version: ${JSON.stringify(payload.schema_version)}`);
  checkSchema(payload);
  return { envelope: wire, header, payload };
}
function decodeReceipt(receipt) {
  return jwsParts(receipt).payload;
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
async function verifyReceipt(receipt, publicKeys, opts = {}) {
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) {
    throw new VerificationError("receipt must be an object");
  }
  const { envelope, header, payload: decoded } = jwsParts(receipt);
  const ownReceipt = decoded;
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
  const r = decoded;
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
      throw new VerificationError(`event must be one of ${JSON.stringify(Object.keys(EVENT_DECISIONS).sort())}, got ${JSON.stringify(event)}`);
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
  if (hasEvent) {
    if (ownReceipt.event === "receipt.checkpoint") {
      if (ownReceipt.policy_ref !== null)
        throw new VerificationError("receipt.checkpoint must have null policy_ref");
    } else if (ownReceipt.policy_ref === null) {
      throw new VerificationError("authorization event must have non-null policy_ref");
    }
  } else if (r.authorization_id === null) {
    if (ownReceipt.policy_ref !== null)
      throw new VerificationError("unresolved authorization must have null policy_ref");
  } else if (ownReceipt.policy_ref === null && ownReceipt.action !== "record.seal") {
    throw new VerificationError("governed action must have non-null policy_ref");
  }
  const issuedAt = parseRFC3339(r.issued_at);
  if (issuedAt.getTime() > nowMs + MAX_FUTURE_SKEW_MS) {
    throw new VerificationError(`receipt issued in the future: ${issuedAt.toISOString()} > ${new Date(nowMs).toISOString()}`);
  }
  const key = findKey(keySnapshots, header.kid, issuedAt);
  const fingerprint = publicKeyFingerprint(key);
  if (opts.trustedKeyFingerprints !== void 0 && !opts.trustedKeyFingerprints.has(fingerprint)) {
    throw new VerificationError(`public key fingerprint is not trusted: ${fingerprint}`);
  }
  try {
    const cryptoKey = await importJWK({ kty: "OKP", crv: "Ed25519", x: base64url_exports.encode(key.publicKeyBytes) }, "EdDSA");
    await compactVerify([envelope.protected, envelope.payload, envelope.signature].join("."), cryptoKey, { algorithms: ["EdDSA"] });
  } catch {
    throw new VerificationError("signature verification failed");
  }
  return decoded;
}
var PUBLIC_KEY_FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/;
var SEAL_PROFILE = "allowly.seal.jcs-sha256.v1";
var SEAL_ACTION = "record.seal";
var SEAL_AGENT_ID = "allowly.seal";
var SEAL_USER_ID = "allowly:seal";
var SEAL_MAX_UTF8_BYTES = 1048576;
var SEAL_MAX_DEPTH = 32;
var SealInputError = class extends Error {
  code;
  constructor(code, message2) {
    super(message2);
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
    ownReceipt = await verifyReceipt(receipt, publicKeys, opts);
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
  checkPolicyRef(receipt.policy_ref);
  if (receipt.engine_version.length !== 71 || !PUBLIC_KEY_FINGERPRINT_RE.test(receipt.engine_version))
    throw new VerificationError("engine_version must be sha256: followed by 64 lowercase hex characters");
  if (Object.hasOwn(receipt, "policy_eval")) {
    checkPolicyEval(receipt.policy_eval);
    if (receipt.policy_ref === null)
      throw new VerificationError("policy_eval requires non-null policy_ref");
  }
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
function checkPolicyRef(value) {
  if (value === null)
    return;
  if (typeof value !== "object" || Array.isArray(value))
    throw new VerificationError("policy_ref must be an object or null");
  const ref = value;
  checkExactKeys(ref, ["policy_id", "policy_version", "definition_sha256"], "policy_ref");
  if (typeof ref.policy_id !== "string" || !ref.policy_id)
    throw new VerificationError("policy_ref.policy_id must be a nonempty string");
  if (typeof ref.policy_version !== "number" || !Number.isSafeInteger(ref.policy_version) || ref.policy_version < 1)
    throw new VerificationError("policy_ref.policy_version must be a positive safe integer");
  if (typeof ref.definition_sha256 !== "string" || ref.definition_sha256.length !== 64 || !/^[0-9a-f]{64}$/.test(ref.definition_sha256))
    throw new VerificationError("policy_ref.definition_sha256 must be 64 lowercase hex characters");
}
function checkPolicyEval(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new VerificationError("policy_eval must be an object");
  const evidence = value;
  checkExactKeys(evidence, ["input_sha256", "result"], "policy_eval");
  if (typeof evidence.input_sha256 !== "string" || evidence.input_sha256.length !== 64 || !/^[0-9a-f]{64}$/.test(evidence.input_sha256))
    throw new VerificationError("policy_eval.input_sha256 must be 64 lowercase hex characters");
  const valueResult = evidence.result;
  if (typeof valueResult !== "object" || valueResult === null || Array.isArray(valueResult))
    throw new VerificationError("policy_eval.result must be an object");
  const result = valueResult;
  checkExactKeys(result, ["profile", "status", "decision", "target", "matched_rule_id", "evaluated_fields"], "policy_eval.result");
  if (result.profile !== "allowly.basic.v1" || result.status !== "ok")
    throw new VerificationError("policy_eval.result requires allowly.basic.v1 successful status");
  if (typeof result.decision !== "string" || !ACTION_DECISIONS.has(result.decision))
    throw new VerificationError("policy_eval.result.decision must be allow, deny, confirm, or escalate");
  const target = result.target;
  const validTarget = result.decision === "allow" || result.decision === "deny" ? target === null : result.decision === "confirm" ? target === "agent_owner" : typeof target === "string" && target.startsWith("member:") && target.length > 7 && [...target].length <= 256;
  if (!validTarget)
    throw new VerificationError("policy_eval.result.target does not match decision");
  const rule = result.matched_rule_id;
  if (rule !== null && (typeof rule !== "string" || !rule || [...rule].length > 128))
    throw new VerificationError("policy_eval.result.matched_rule_id must be a bounded nonempty string or null");
  const fields = result.evaluated_fields;
  if (typeof fields !== "object" || fields === null || Array.isArray(fields) || Object.keys(fields).some((key) => !key || [...key].length > 128))
    throw new VerificationError("policy_eval.result.evaluated_fields must be an object with bounded nonempty field names");
  if (rule === null && Object.keys(fields).length)
    throw new VerificationError("policy_eval.result default requires empty evaluated_fields");
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
  decodeReceipt,
  hashSealJson,
  hashSealValue,
  loadKeysFromJson,
  publicKeyFingerprint,
  verifySealJson,
  verifySealValue
});
