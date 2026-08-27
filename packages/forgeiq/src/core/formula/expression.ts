// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// ─────────────────────────────────────────────────────────────────────────────
// Calculated values, without handing a merchant a JavaScript interpreter.
//
// A merchant writes `productWidth * 0.04` or `width > 36 ? 4 : 2` and ForgeIQ
// evaluates it deterministically, at runtime, for every customer. Which means
// the expression is UNTRUSTED INPUT that runs on the server, and the obvious
// implementation — `eval` or `new Function` — hands whoever can edit a product
// definition the ability to run code. The directive forbids it and it would be
// wrong regardless.
//
// So this is a real tokenizer and a recursive-descent parser over a closed
// grammar. There is no property access, no function definition, no assignment,
// no loops, and no way to name anything the evaluator was not given. The only
// callable things are the arithmetic helpers in FUNCTIONS below.
//
// It is also bounded: expressions have a length limit and the parser has a
// depth limit, because "deterministic" is not the same as "terminates", and a
// merchant who pastes ten thousand nested parentheses should get an error
// rather than a stack overflow in a request handler.
// ─────────────────────────────────────────────────────────────────────────────

/** Longest expression accepted. Generous for a formula, hostile to a payload. */
export const MAX_EXPRESSION_LENGTH = 1_000;

/** Deepest nesting accepted, so a pathological input cannot exhaust the stack. */
export const MAX_EXPRESSION_DEPTH = 32;

/**
 * The functions a formula may call. Nothing else is reachable.
 *
 * Every one is pure and total: given the same numbers it returns the same
 * number, and none of them can throw. A formula that could throw would fail a
 * customer's configuration at checkout for a reason nobody could explain.
 */
const FUNCTIONS: Readonly<Record<string, (...args: number[]) => number>> = Object.freeze({
  floor: (a) => Math.floor(a!),
  ceil: (a) => Math.ceil(a!),
  round: (a) => Math.round(a!),
  abs: (a) => Math.abs(a!),
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  // Guarded: sqrt of a negative is NaN, which would propagate silently through
  // every later operation and surface as a blank dimension.
  sqrt: (a) => (a! < 0 ? 0 : Math.sqrt(a!)),
  clamp: (v, lo, hi) => Math.min(Math.max(v!, lo!), hi!),
});

export type FormulaScope = Readonly<Record<string, number | boolean | string>>;

export class FormulaError extends Error {
  constructor(
    message: string,
    readonly position?: number,
  ) {
    super(message);
    this.name = "FormulaError";
  }
}

// ---------- Tokens ----------

type TokenType = "number" | "string" | "ident" | "op" | "paren" | "comma" | "end";

interface Token {
  readonly type: TokenType;
  readonly value: string;
  readonly pos: number;
}

const OPERATORS = [
  "<=", ">=", "==", "!=", "&&", "||",
  "+", "-", "*", "/", "%", "<", ">", "!", "?", ":",
];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i]!;

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j]!)) j += 1;
      const raw = source.slice(i, j);
      if ((raw.match(/\./g) ?? []).length > 1) {
        throw new FormulaError(`"${raw}" is not a number`, i);
      }
      tokens.push({ type: "number", value: raw, pos: i });
      i = j;
      continue;
    }

    // Single-quoted strings only, for comparing against option ids. Double
    // quotes are excluded so a formula can be embedded in JSON without
    // escaping, which is where these actually live.
    if (ch === "'") {
      const end = source.indexOf("'", i + 1);
      if (end === -1) throw new FormulaError("unterminated string", i);
      tokens.push({ type: "string", value: source.slice(i + 1, end), pos: i });
      i = end + 1;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ type: "ident", value: source.slice(i, j), pos: i });
      i = j;
      continue;
    }

    if (ch === "(" || ch === ")") {
      tokens.push({ type: "paren", value: ch, pos: i });
      i += 1;
      continue;
    }

    if (ch === ",") {
      tokens.push({ type: "comma", value: ch, pos: i });
      i += 1;
      continue;
    }

    const two = source.slice(i, i + 2);
    const op = OPERATORS.includes(two) ? two : OPERATORS.includes(ch) ? ch : null;
    if (op) {
      tokens.push({ type: "op", value: op, pos: i });
      i += op.length;
      continue;
    }

    // Anything unrecognised is refused rather than skipped. A silently ignored
    // character is how `width $ 2` becomes `width` and a sign comes out wrong.
    throw new FormulaError(`unexpected character "${ch}"`, i);
  }

  tokens.push({ type: "end", value: "", pos: source.length });
  return tokens;
}

// ---------- AST ----------

type Node =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "ident"; name: string }
  | { kind: "unary"; op: string; operand: Node }
  | { kind: "binary"; op: string; left: Node; right: Node }
  | { kind: "ternary"; test: Node; whenTrue: Node; whenFalse: Node }
  | { kind: "call"; name: string; args: Node[] };

/** Binding power, loosest first. Mirrors the usual arithmetic expectations. */
const BINARY_PRECEDENCE: Readonly<Record<string, number>> = {
  "||": 1, "&&": 2,
  "==": 3, "!=": 3,
  "<": 4, ">": 4, "<=": 4, ">=": 4,
  "+": 5, "-": 5,
  "*": 6, "/": 6, "%": 6,
};

function parse(tokens: Token[]): Node {
  let index = 0;
  let depth = 0;

  const peek = (): Token => tokens[index]!;
  const next = (): Token => tokens[index++]!;

  const expect = (value: string): void => {
    const token = next();
    if (token.value !== value) {
      throw new FormulaError(`expected "${value}"`, token.pos);
    }
  };

  const guardDepth = (token: Token): void => {
    if (depth > MAX_EXPRESSION_DEPTH) {
      throw new FormulaError("expression is nested too deeply", token.pos);
    }
  };

  function parsePrimary(): Node {
    const token = next();

    if (token.type === "number") return { kind: "number", value: Number(token.value) };
    if (token.type === "string") return { kind: "string", value: token.value };

    if (token.type === "op" && (token.value === "-" || token.value === "!")) {
      depth += 1;
      guardDepth(token);
      const operand = parsePrimary();
      depth -= 1;
      return { kind: "unary", op: token.value, operand };
    }

    if (token.value === "(") {
      depth += 1;
      guardDepth(token);
      const inner = parseExpression(0);
      depth -= 1;
      expect(")");
      return inner;
    }

    if (token.type === "ident") {
      if (peek().value === "(") {
        next();
        const args: Node[] = [];
        if (peek().value !== ")") {
          depth += 1;
          guardDepth(token);
          for (;;) {
            args.push(parseExpression(0));
            if (peek().type !== "comma") break;
            next();
          }
          depth -= 1;
        }
        expect(")");
        return { kind: "call", name: token.value, args };
      }
      return { kind: "ident", name: token.value };
    }

    throw new FormulaError(`unexpected "${token.value || "end of expression"}"`, token.pos);
  }

  function parseExpression(minPrecedence: number): Node {
    let left = parsePrimary();

    for (;;) {
      const token = peek();
      if (token.type !== "op") break;

      if (token.value === "?" && minPrecedence === 0) {
        next();
        depth += 1;
        guardDepth(token);
        const whenTrue = parseExpression(0);
        expect(":");
        const whenFalse = parseExpression(0);
        depth -= 1;
        left = { kind: "ternary", test: left, whenTrue, whenFalse };
        continue;
      }

      const precedence = BINARY_PRECEDENCE[token.value];
      if (precedence === undefined || precedence < minPrecedence) break;

      next();
      depth += 1;
      guardDepth(token);
      // Left-associative: parse the right side at one level tighter.
      const right = parseExpression(precedence + 1);
      depth -= 1;
      left = { kind: "binary", op: token.value, left, right };
    }

    return left;
  }

  const ast = parseExpression(0);
  const trailing = peek();
  if (trailing.type !== "end") {
    throw new FormulaError(`unexpected "${trailing.value}" after the expression`, trailing.pos);
  }
  return ast;
}

// ---------- Evaluation ----------

type Value = number | boolean | string;

const truthy = (v: Value): boolean =>
  typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : v.length > 0;

const asNumber = (v: Value, op: string): number => {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new FormulaError(`"${op}" needs a number, got the text "${v}"`);
};

function evaluateNode(node: Node, scope: FormulaScope): Value {
  switch (node.kind) {
    case "number":
      return node.value;
    case "string":
      return node.value;

    case "ident": {
      // `true`/`false` are literals rather than scope entries, so a merchant
      // cannot shadow them with a variable and invert every rule downstream.
      if (node.name === "true") return true;
      if (node.name === "false") return false;
      if (!(node.name in scope)) {
        // Refused, not defaulted to zero. A misspelled variable silently
        // becoming 0 turns `width * 0.04` into a border of nothing, and the
        // sign ships wrong.
        throw new FormulaError(`"${node.name}" is not a value this formula can use`);
      }
      return scope[node.name]!;
    }

    case "unary": {
      const value = evaluateNode(node.operand, scope);
      return node.op === "-" ? -asNumber(value, "-") : !truthy(value);
    }

    case "ternary":
      return truthy(evaluateNode(node.test, scope))
        ? evaluateNode(node.whenTrue, scope)
        : evaluateNode(node.whenFalse, scope);

    case "binary": {
      // Short-circuit before evaluating the right side, so `a && b` does not
      // fail on an undefined `b` that the guard exists to avoid reaching.
      if (node.op === "&&") {
        const left = evaluateNode(node.left, scope);
        return truthy(left) ? truthy(evaluateNode(node.right, scope)) : false;
      }
      if (node.op === "||") {
        const left = evaluateNode(node.left, scope);
        return truthy(left) ? true : truthy(evaluateNode(node.right, scope));
      }

      const left = evaluateNode(node.left, scope);
      const right = evaluateNode(node.right, scope);

      switch (node.op) {
        case "==": return left === right;
        case "!=": return left !== right;
        case "+":
          // Deliberately arithmetic only. Implicit string concatenation is how
          // `width + margin` silently becomes "244" instead of 28.
          return asNumber(left, "+") + asNumber(right, "+");
        case "-": return asNumber(left, "-") - asNumber(right, "-");
        case "*": return asNumber(left, "*") * asNumber(right, "*");
        case "%": {
          const divisor = asNumber(right, "%");
          if (divisor === 0) throw new FormulaError("cannot take a remainder by zero");
          return asNumber(left, "%") % divisor;
        }
        case "/": {
          const divisor = asNumber(right, "/");
          // An explicit error, not Infinity. Infinity propagates into a
          // dimension and produces a product nobody can make.
          if (divisor === 0) throw new FormulaError("cannot divide by zero");
          return asNumber(left, "/") / divisor;
        }
        case "<": return asNumber(left, "<") < asNumber(right, "<");
        case ">": return asNumber(left, ">") > asNumber(right, ">");
        case "<=": return asNumber(left, "<=") <= asNumber(right, "<=");
        case ">=": return asNumber(left, ">=") >= asNumber(right, ">=");
        default:
          throw new FormulaError(`unknown operator "${node.op}"`);
      }
    }

    case "call": {
      const fn = FUNCTIONS[node.name];
      if (!fn) {
        throw new FormulaError(`"${node.name}" is not a function a formula can call`);
      }
      const args = node.args.map((arg) => asNumber(evaluateNode(arg, scope), node.name));
      return fn(...args);
    }
  }
}

export interface CompiledFormula {
  readonly source: string;
  /** Every scope value the formula reads. What a caller must supply. */
  readonly dependencies: ReadonlyArray<string>;
  evaluate(scope: FormulaScope): Value;
}

function collectDependencies(node: Node, into: Set<string>): void {
  switch (node.kind) {
    case "ident":
      if (node.name !== "true" && node.name !== "false") into.add(node.name);
      return;
    case "unary":
      collectDependencies(node.operand, into);
      return;
    case "binary":
      collectDependencies(node.left, into);
      collectDependencies(node.right, into);
      return;
    case "ternary":
      collectDependencies(node.test, into);
      collectDependencies(node.whenTrue, into);
      collectDependencies(node.whenFalse, into);
      return;
    case "call":
      for (const arg of node.args) collectDependencies(arg, into);
      return;
    default:
      return;
  }
}

/**
 * Parses once, evaluates many times.
 *
 * Compiling at publish time means a broken formula is a merchant's problem
 * before a customer ever sees it, rather than an error during checkout.
 * `dependencies` is what makes that check possible: a caller can verify every
 * name resolves before publishing.
 */
export function compileFormula(source: string): CompiledFormula {
  if (source.length > MAX_EXPRESSION_LENGTH) {
    throw new FormulaError(
      `formula is ${source.length} characters; the limit is ${MAX_EXPRESSION_LENGTH}`,
    );
  }

  const ast = parse(tokenize(source));
  const dependencies = new Set<string>();
  collectDependencies(ast, dependencies);

  return {
    source,
    dependencies: [...dependencies].sort(),
    evaluate: (scope) => evaluateNode(ast, scope),
  };
}

/** Compile and evaluate in one step, for a formula used once. */
export function evaluateFormula(source: string, scope: FormulaScope): Value {
  return compileFormula(source).evaluate(scope);
}

/**
 * Checks a formula without running it.
 *
 * For the builder: tell a merchant their formula is wrong while they are
 * writing it, naming the variable they misspelled.
 */
export function validateFormula(
  source: string,
  availableNames: ReadonlyArray<string>,
): { ok: true; dependencies: ReadonlyArray<string> } | { ok: false; error: string } {
  try {
    const compiled = compileFormula(source);
    const available = new Set(availableNames);
    const unknown = compiled.dependencies.filter((d) => !available.has(d));
    if (unknown.length > 0) {
      return { ok: false, error: `unknown ${unknown.length === 1 ? "value" : "values"}: ${unknown.join(", ")}` };
    }
    return { ok: true, dependencies: compiled.dependencies };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
