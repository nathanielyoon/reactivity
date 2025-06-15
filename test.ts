import {
  assertEquals,
  assertLess,
  assertNotEquals,
  assertThrows,
} from "jsr:@std/assert@^1.0.13";
import {
  assertSpyCall,
  assertSpyCalls,
  spy,
} from "jsr:@std/testing@^1.0.13/mock";
import {
  cached,
  debatch,
  effect,
  enbatch,
  scoper,
  set_point,
  signal,
} from "./mod.ts";

Deno.test("computed", () => {
  {
    const src = signal(0);
    const c1 = cached(() => src() % 2);
    const c2 = cached(() => c1());
    const c3 = cached(() => c2());
    c3(), src(1), c2(), src(3), assertEquals(c3(), 1);
  }
  {
    const src = signal(0);
    const a = cached(() => src());
    const b = cached(() => a() % 2);
    const c = cached(() => src());
    const d = cached(() => b() + c());
    assertEquals(d(), 0), src(2), assertEquals(d(), 2);
  }
  {
    const a = signal(false);
    const b = cached(() => a());
    const c = cached(() => (b(), 0));
    const d = cached(() => (c(), b()));
    assertEquals(d(), false), a(true), assertEquals(d(), true);
  }
  {
    let times = 0;
    const src = signal(0);
    const c1 = cached(() => (++times, src()));
    c1(), assertEquals(times, 1), src(1), src(0), c1(), assertEquals(times, 1);
  }
});
Deno.test("effectScope", () => {
  {
    const count = signal(1);
    let triggers = 0, _effect1;
    const stopScope = scoper(() => {
      _effect1 = effect(() => (++triggers, count()));
      assertEquals(triggers, 1), count(2), assertEquals(triggers, 2);
    });
    count(3), assertEquals(triggers, 3);
    stopScope(), count(4), assertEquals(triggers, 3);
  }
  {
    const source = signal(1);
    let triggers = 0;
    effect(() => {
      const dispose = scoper(() => effect(() => (source(), ++triggers)));
      assertEquals(triggers, 1), source(2), assertEquals(triggers, 2);
      dispose(), source(3), assertEquals(triggers, 2);
    });
  }
});
Deno.test("effect", () => {
  {
    let bRunTimes = 0;
    const a = signal(1);
    const b = cached(() => (++bRunTimes, a() * 2));
    const stopEffect = effect(() => b());
    assertEquals(bRunTimes, 1), a(2), assertEquals(bRunTimes, 2);
    stopEffect(), a(3), assertEquals(bRunTimes, 2);
  }
  {
    const a = signal(3);
    const b = cached(() => a() > 0);
    effect(() => b() && effect(() => assertNotEquals(a(), 0)));
    a(2), a(1), a(0);
  }
  {
    const a = signal(1);
    const b = signal(1);
    effect(() => a() && effect(() => (b(), assertEquals(a(), 1))));
    enbatch(), b(0), a(0), debatch();
  }
  {
    const a = signal(0);
    const b = cached(() => a() % 2);
    let innerTriggerTimes = 0;
    effect(() => effect(() => (b(), assertLess(++innerTriggerTimes, 3))));
    a(2);
  }
  {
    const a = signal(0);
    const b = signal(0);
    const c = cached(() => a() - b());
    const order: number[] = [];
    effect(() => {
      c();
      effect(() => (order.push(0), a()));
      effect(() => (order.push(1), a(), b()));
    });
    order.length = 0;
    enbatch(), b(1), a(1), debatch(), assertEquals(order, [0, 1]);
  }
  {
    const batchEffect = (fn: () => void) =>
      effect(() => {
        enbatch();
        try {
          return fn();
        } finally {
          debatch();
        }
      });
    const logs: number[] = [];
    const a = signal(0);
    const b = signal(0);
    const aa = cached(() => (logs.push(0), a() || b(1), logs.push(1)));
    const bb = cached(() => (logs.push(2), b()));
    batchEffect(() => bb()), batchEffect(() => aa());
    assertEquals(logs, [2, 0, 1, 2]);
  }
  {
    const src1 = signal(0);
    const src2 = signal(0);
    const order: number[] = [];
    effect(() => {
      order.push(0);
      const currentSub = set_point(undefined);
      const isOne = src2() === 1;
      set_point(currentSub);
      isOne && src1(), src2(), src1();
    });
    effect(() => (order.push(1), src1()));
    src2(1), order.length = 0, src1(src1() + 1), assertEquals(order, [0, 1]);
  }
  {
    const a = signal(0);
    const b = signal(0);
    const order: number[] = [];
    effect(() => {
      effect(() => (a(), order.push(0)));
      effect(() => (b(), order.push(1)));
      assertEquals(order, [0, 1]);
      order.length = 0, b(1), a(1), assertEquals(order, [1, 0]);
    });
  }
  {
    const a = signal(false);
    const b = cached(() => a());
    const c = cached(() => (b(), 0));
    const d = cached(() => (c(), b()));
    let triggers = 0;
    effect(() => (d(), ++triggers));
    assertEquals(triggers, 1), a(true), assertEquals(triggers, 2);
  }
});
const untracked = <A>(callback: () => A) => {
  const currentSub = set_point(undefined);
  try {
    return callback();
  } finally {
    set_point(currentSub);
  }
};
interface ReactionOptions<A, B extends boolean = boolean> {
  fireImmediately?: B;
  equals?: B extends true ? (a: A, b: A | undefined) => boolean
    : (a: A, b: A) => boolean;
  onError?: (error: unknown) => void;
  scheduler?: (fn: () => void) => void;
  once?: boolean;
}
const reaction = <A>(
  dataFn: () => A,
  effectFn: (newValue: A, oldValue: A | undefined) => void,
  options: ReactionOptions<A> = {},
) => {
  const {
    scheduler = (fn) => fn(),
    equals = Object.is,
    onError,
    once = false,
    fireImmediately = false,
  } = options;
  let prevValue: A | undefined, version = 0;
  const tracked = cached(() => {
    try {
      return dataFn();
    } catch (error) {
      return untracked(() => onError?.(error)), prevValue!;
    }
  });
  const dispose = effect(() => {
    const current = tracked();
    if (!fireImmediately && version) prevValue = current;
    ++version;
    if (equals(current, prevValue!)) return;
    const oldValue = prevValue;
    prevValue = current;
    untracked(() =>
      scheduler(() => {
        try {
          effectFn(current, oldValue);
        } catch (error) {
          onError?.(error);
        } finally {
          if (once) {
            if (fireImmediately && version > 1) dispose();
            else if (!fireImmediately && version > 0) dispose();
          }
        }
      })
    );
  });
};
Deno.test("issue_48", () => {
  const source = signal(0);
  let disposeInner;
  reaction(
    () => source(),
    (val) => {
      if (val === 1) disposeInner = reaction(() => source(), () => {});
      else if (val === 2) disposeInner!();
    },
  );
  source(1), source(2), source(3);
});
Deno.test("untrack", () => {
  {
    const src = signal(0);
    let computedTriggerTimes = 0;
    const c = cached(() => {
      ++computedTriggerTimes;
      const currentSub = set_point(undefined);
      const value = src();
      set_point(currentSub);
      return value;
    });
    assertEquals(c(), 0), assertEquals(computedTriggerTimes, 1);
    src(1), src(2), src(3);
    assertEquals(c(), 0), assertEquals(computedTriggerTimes, 1);
  }
  {
    const src = signal(0);
    const is = signal(0);
    let effectTriggerTimes = 0;
    effect(() => {
      ++effectTriggerTimes;
      if (is()) {
        const currentSub = set_point(undefined);
        src(), set_point(currentSub);
      }
    });
    assertEquals(effectTriggerTimes, 1);
    is(1), assertEquals(effectTriggerTimes, 2);
    src(1), src(2), src(3), assertEquals(effectTriggerTimes, 2);
    is(2), assertEquals(effectTriggerTimes, 3);
    src(4), src(5), src(6), assertEquals(effectTriggerTimes, 3);
    is(0), assertEquals(effectTriggerTimes, 4);
    src(7), src(8), src(9), assertEquals(effectTriggerTimes, 4);
  }
  {
    const src = signal(0);
    let effectTriggerTimes = 0;
    scoper(() =>
      effect(() => {
        ++effectTriggerTimes;
        const currentSub = set_point(undefined);
        src(), set_point(currentSub);
      })
    );
    assertEquals(effectTriggerTimes, 1);
    src(1), src(2), src(3), assertEquals(effectTriggerTimes, 1);
  }
});
Deno.test("graph updates", () => {
  {
    const a = signal(2);
    const b = cached(() => a() - 1);
    const c = cached(() => a() + b());
    const computer = () => spy(() => `d: ${c()}`);
    let compute = computer();
    let d = cached(compute);
    assertEquals(d(), "d: 3"), assertSpyCalls(compute, 1);
    // Reassign for `.mockClear()`.
    d = cached(compute = computer());
    a(4), d(), assertSpyCalls(compute, 1);
  }
  {
    const a = signal("a");
    const b = cached(() => a());
    const c = cached(() => a());
    const compute = spy(() => `${b()} ${c()}`);
    const d = cached(compute);
    assertEquals(d(), "a a"), assertSpyCalls(compute, 1);
    a("aa"), assertEquals(d(), "aa aa"), assertSpyCalls(compute, 2);
  }
  {
    const a = signal("a");
    const b = cached(() => a());
    const c = cached(() => a());
    const d = cached(() => `${b()} ${c()}`);
    const compute = spy(() => d());
    const e = cached(compute);
    assertEquals(e(), "a a"), assertSpyCalls(compute, 1);
    a("aa"), assertEquals(e(), "aa aa"), assertSpyCalls(compute, 2);
  }
  {
    const a = signal("a");
    const b = cached(() => (a(), "foo"));
    const compute = spy(() => b());
    const c = cached(compute);
    assertEquals(c(), "foo"), assertSpyCalls(compute, 1);
    a("aa"), assertEquals(c(), "foo"), assertSpyCalls(compute, 1);
  }
  {
    const a = signal("a");
    const b = cached(() => a());
    const c = cached(() => a());
    const d = cached(() => c());
    const calls: string[] = [];
    const computer_e = () => spy(() => (calls.push("e"), `${b()} ${d()}`));
    let eSpy = computer_e();
    let e = cached(eSpy);
    const computer_f = () => spy(() => (calls.push("f"), e()));
    let fSpy = computer_f();
    let f = cached(fSpy);
    const computer_g = () => spy(() => (calls.push("g"), e()));
    let gSpy = computer_g();
    let g = cached(gSpy);
    assertEquals(f(), "a a"), assertSpyCalls(fSpy, 1);
    assertEquals(g(), "a a"), assertSpyCalls(gSpy, 1);
    e = cached(eSpy = computer_e());
    f = cached(fSpy = computer_f());
    g = cached(gSpy = computer_g());
    a("b");
    assertEquals(e(), "b b"), assertSpyCalls(eSpy, 1);
    assertEquals(f(), "b b"), assertSpyCalls(fSpy, 1);
    assertEquals(g(), "b b"), assertSpyCalls(gSpy, 1);
    e = cached(eSpy = computer_e());
    f = cached(fSpy = computer_f());
    g = cached(gSpy = computer_g());
    calls.length = 0;
    a("c");
    assertEquals(e(), "c c"), assertSpyCalls(eSpy, 1);
    assertEquals(f(), "c c"), assertSpyCalls(fSpy, 1);
    assertEquals(g(), "c c"), assertSpyCalls(gSpy, 1);
    const order = ["e", "f", "g"].map(($) => calls.indexOf($));
    assertLess(order[0], order[1]), assertLess(order[1], order[2]);
  }
  {
    const a = signal("a");
    const b = cached(() => a());
    const compute = spy(() => a());
    cached(compute);
    assertEquals(b(), "a"), assertSpyCalls(compute, 0);
    a("aa"), assertEquals(b(), "aa"), assertSpyCalls(compute, 0);
  }
  {
    const a = signal("a");
    const compute_b = () => spy(() => a());
    let bSpy = compute_b();
    let b = cached(bSpy);
    const compute_c = () => spy(() => b());
    let cSpy = compute_c();
    let c = cached(cSpy);
    const d = cached(() => a());
    let result = "";
    const unsub = effect(() => result = c());
    assertEquals(result, "a"), assertEquals(d(), "a");
    b = cached(bSpy = compute_b());
    c = cached(cSpy = compute_c());
    unsub();
    a("aa");
    assertSpyCalls(bSpy, 0), assertSpyCalls(cSpy, 0), assertEquals(d(), "aa");
  }
  {
    const a = signal("a");
    const b = cached(() => a());
    const c = cached(() => (a(), "c"));
    const computer = () => spy(() => `${b()} ${c()}`);
    let compute = computer();
    let d = cached(compute);
    assertEquals(d(), "a c");
    d = cached(compute = computer());
    a("aa"), d(), assertSpyCall(compute, 0, { returned: "aa c" });
  }
  {
    const a = signal("a");
    const b = cached(() => a());
    const c = cached(() => (a(), "c"));
    const d = cached(() => (a(), "d"));
    const computer = () => spy(() => `${b()} ${c()} ${d()}`);
    let compute = computer();
    let e = cached(compute);
    assertEquals(e(), "a c d");
    e = cached(compute = computer());
    a("aa"), e(), assertSpyCall(compute, 0, { returned: "aa c d" });
  }
  {
    const a = signal(0);
    const b = cached(() => a());
    const c = cached(() => a() > 0 ? a() : b());
    assertEquals(c(), 0), a(1), assertEquals(c(), 1);
    a(0), assertEquals(c(), 0);
  }
  {
    const a = signal("a");
    const b = cached(() => (a(), "b"));
    const c = cached(() => (a(), "c"));
    const computer = () => spy(() => `${b()} ${c()}`);
    let compute = computer();
    let d = cached(compute);
    assertEquals(d(), "b c");
    d = cached(compute = computer());
    a("aa"), assertSpyCalls(compute, 0);
  }
});
Deno.test("error handling", () => {
  {
    const a = signal(0);
    const b = cached(() => {
      throw new Error();
    });
    const c = cached(() => a());
    assertThrows(() => b());
    a(1), assertEquals(c(), 1);
  }
  {
    const a = signal(0);
    const b = cached(() => {
      if (a() === 1) throw new Error();
      return a();
    });
    const c = cached(() => b());
    assertEquals(c(), 0), a(1), assertThrows(() => b());
    a(2), assertEquals(c(), 2);
  }
});
