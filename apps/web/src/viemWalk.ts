// Shim for a viem bug that swallowed real wallet errors and aborted opens/closes.
//
// THE BUG (viem 2.55.2, errors/base.js):
//
//   function walk(err, fn) {
//     if (fn?.(err)) return err;                       // ← predicate runs FIRST…
//     if (err && typeof err === "object" && "cause" in err && err.cause !== undefined)
//       return walk(err.cause, fn);                    // …then recurses into the cause
//     return fn ? null : err;
//   }
//
// The type guard protects the RECURSION but not the PREDICATE. So the moment any link in
// a `.cause` chain is a primitive, the next call does `fn(primitive)` — and viem's own
// predicates are property tests like `(e) => "data" in e`. `"data" in "some string"`
// throws a TypeError.
//
// Where it bites us: `getContractError` runs exactly that predicate on every failed
// contract write. Some wallets reject with a bare string rather than an Error, so the
// string lands in the cause chain, and viem throws a TypeError *while formatting the real
// error*. The genuine wallet message is destroyed and the user gets
// `w is not an Object. (evaluating '"data"in w')` — which is what killed a position open
// on 2026-07-25 ("buy the ask-side wing") and a close on 2026-07-24. Both were Safari:
// the capital-O wording is WebKit's, and the trigger is that wallet's rejection shape, so
// it never reproduced in desktop Chrome.
//
// THE FIX: override `BaseError.prototype.walk` — the public method every viem call site
// uses, `getContractError` included — with a primitive-safe walk. Semantics are preserved
// exactly: `walk(fn)` returns the first matching link or null, `walk()` returns the
// deepest link. The only difference is that primitives are never handed to the predicate,
// which is harmless because a primitive cannot own the properties viem is testing for.
//
// Remove this once upstream guards the predicate; the tests alongside it will keep passing
// either way.
import { BaseError } from "viem";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** viem's walk, minus the crash. Iterative so a self-referential cause can't blow the stack. */
export function safeWalk(err: unknown, fn?: (e: unknown) => boolean): unknown {
  let cur: unknown = err;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 64; depth++) {
    // Primitives are skipped rather than tested: viem's predicates are all property
    // checks, and `in` against a primitive is precisely the throw we're preventing.
    if (fn && isObj(cur) && fn(cur)) return cur;
    if (!isObj(cur) || !("cause" in cur) || cur.cause === undefined) break;
    if (seen.has(cur)) break; // cyclic cause chain — bail rather than spin
    seen.add(cur);
    cur = cur.cause;
  }
  return fn ? null : cur;
}

let installed = false;

/** Call once at boot, before any contract write can happen. */
export function installViemWalkFix(): void {
  if (installed) return;
  installed = true;
  (BaseError.prototype as unknown as { walk: (fn?: (e: unknown) => boolean) => unknown }).walk =
    function walk(this: unknown, fn?: (e: unknown) => boolean) {
      return safeWalk(this, fn);
    };
}
