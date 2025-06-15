const enum Flag {
  MAYBE = 1 << 0,
  WATCH = 1 << 1,
  CHECK = 1 << 2,
  RECUR = 1 << 3,
  DIRTY = 1 << 4,
  READY = 1 << 5,
  QUEUE = 1 << 6,
  RESET = Flag.MAYBE | Flag.DIRTY,
}
const enum Kind {
  SIGNAL,
  CACHED,
  EFFECT,
  SCOPER,
}
interface Node {
  head: Link | undefined;
  deps: Link | undefined;
  subs: Link | undefined;
  tail: Link | undefined;
  flags: number;
}
interface SignalNode<A = any> extends Node {
  kind: Kind.SIGNAL;
  has: A;
  old: A;
}
interface CachedNode<A = any> extends Node {
  kind: Kind.CACHED;
  has?: A;
  get: (old?: A) => A;
}
interface EffectNode extends Node {
  kind: Kind.EFFECT;
  run: () => void;
}
interface ScoperNode extends Node {
  kind: Kind.SCOPER;
}
type ReactiveNode = SignalNode | CachedNode | EffectNode | ScoperNode;
interface Link {
  dep_prev: Link | undefined;
  dep: ReactiveNode;
  dep_next: Link | undefined;
  sub_prev: Link | undefined;
  sub: ReactiveNode;
  sub_next: Link | undefined;
}
const ok = (check: Link, sub: ReactiveNode) => {
  const head = sub.head;
  if (head) {
    let link = sub.deps;
    do if (link === check) return true;
    else if (link === head) return; while (link = link!.dep_next);
  }
};
const enlink = (dep: ReactiveNode, sub: ReactiveNode) => {
  const dep_prev = sub.head;
  if (dep_prev?.dep === dep) return;
  let dep_next;
  if (sub.flags & Flag.CHECK) {
    dep_next = dep_prev ? dep_prev.dep_next : sub.deps;
    if (dep_next?.dep === dep) return void (sub.head = dep_next);
  }
  const prev = dep.tail;
  if (prev?.sub === sub && (!(sub.flags & Flag.CHECK) || ok(prev, sub))) return;
  const link = sub.head = dep.tail = {
    dep_prev,
    dep,
    dep_next,
    sub_prev: prev,
    sub,
    sub_next: undefined,
  };
  if (dep_next) dep_next.dep_prev = link;
  dep_prev ? dep_prev.dep_next = link : sub.deps = link;
  prev ? prev.sub_next = link : dep.subs = link;
};
const delink = (link: Link, sub = link.sub) => {
  const { dep_prev, dep, dep_next, sub_prev, sub_next } = link;
  dep_next ? dep_next.dep_prev = dep_prev : sub.head = dep_prev;
  dep_prev ? dep_prev.dep_next = dep_next : sub.deps = dep_next;
  sub_next ? sub_next.sub_prev = sub_prev : dep.tail = sub_prev;
  if (sub_prev) sub_prev.sub_next = sub_next;
  else if (!(dep.subs = sub_next)) {
    switch (dep.kind) {
      case Kind.CACHED: {
        let pop = dep.deps;
        if (pop) { for (dep.flags = Flag.RESET; pop = delink(pop, dep);); }
        break;
      }
      case Kind.EFFECT:
      case Kind.SCOPER:
        dispose.call(dep);
        break;
    }
  }
  return dep_next;
};
function dispose(this: EffectNode | ScoperNode) {
  let dep = this.deps;
  while (dep) dep = delink(dep, this);
  this.subs && delink(this.subs), this.flags = 0;
}
const start = (sub: ReactiveNode) => ( // ~(RECUR DIRTY READY)
  sub.head = undefined, sub.flags = sub.flags & ~56 | Flag.CHECK
);
const close = (sub: ReactiveNode) => {
  const head = sub.head;
  sub.flags &= ~Flag.CHECK;
  for (let pop = head ? head.dep_next : sub.deps; pop; pop = delink(pop, sub));
};
const shallow = (link: Link) => {
  do if ((link.sub.flags & 48) === 32) {
    (link.sub.flags |= Flag.DIRTY) & Flag.WATCH && notify(link.sub);
  } while (link = link.sub_next!); // lying is ok cause we get caught right away
};
const deep = (link: Link) => {
  top: for (let stack, next = link.sub_next, flags, sub;;) {
    sub = link.sub, flags = sub.flags;
    if (flags & 3) { // MAYBE WATCH
      if (!(flags & 60)) sub.flags |= Flag.READY; // CHECK RECUR DIRTY READY
      else if (!(flags & 12)) flags = 0; // CHECK RECUR
      else if (!(flags & Flag.CHECK)) sub.flags &= ~8; // ~RECUR READY;
      else if (flags & 48 || !ok(link, sub)) flags = 0; // DIRTY READY
      else sub.flags |= 40; // RECUR READY;
    }
    flags & Flag.WATCH && notify(sub);
    if (flags & Flag.MAYBE) {
      if (sub.subs) {
        link = sub.subs;
        if (link.sub_next) stack = { next, stack }, next = link.sub_next;
        continue;
      }
    }
    if (next) link = next, next = link.sub_next;
    else {
      while (stack) {
        link = stack.next!, stack = stack.stack;
        if (link) {
          next = link.sub_next;
          continue top;
        }
      }
      break;
    }
  }
};
const dirt = (link: Link, sub: ReactiveNode) => {
  top: for (let stack, depth = 0;;) {
    const dep = link.dep as SignalNode | CachedNode, flags = dep.flags; // a lie
    let dirty = false;
    if (sub.flags & Flag.DIRTY) dirty = true;
    else if ((flags & Flag.RESET) === Flag.RESET) {
      if (update(dep)) dirty = true, dep.subs!.sub_next && shallow(dep.subs!);
    } else if ((flags & 33) === 33) { // MAYBE | READY
      if (link.sub_next || link.sub_prev) stack = { link, stack };
      ++depth, sub = dep, link = dep.deps!;
      continue;
    }
    if (!dirty && link.dep_next) link = link.dep_next;
    else {
      while (depth--) {
        const tail = sub.subs!;
        if (tail.sub_next) link = stack!.link, stack = stack!.stack;
        else link = tail;
        if (dirty) {
          switch (sub.kind) {
            case Kind.SIGNAL:
              resignal(sub, sub.flags); // falls through
            case Kind.CACHED:
          }
          if (update(sub as SignalNode | CachedNode)) {
            tail.sub_next && shallow(tail), sub = link.sub;
            continue;
          }
        } else sub.flags &= ~Flag.READY;
        sub = link.sub;
        if (link.dep_next) {
          link = link.dep_next;
          continue top;
        }
        dirty = false;
      }
      return dirty;
    }
  }
};
const resignal = (next: SignalNode, value: any) => (
  next.flags = Flag.MAYBE, next.old !== (next.old = value)
);
const recached = (next: CachedNode) => {
  const prev = set_point(next);
  try {
    return start(next), next.has !== (next.has = next.get(next.has));
  } finally {
    set_point(prev), close(next);
  }
};
const update = (sub: SignalNode | CachedNode) =>
  sub.kind === Kind.SIGNAL ? resignal(sub, sub.has) : recached(sub);
const run = (node: ReactiveNode, flags: Flag) => { // extra param
  if (flags & Flag.DIRTY || flags & Flag.READY && dirt(node.deps!, node)) {
    const prev = set_point(node);
    try {
      start(node), (node as EffectNode).run(); // `Scoper` can't be READY/DIRTY
    } finally {
      set_point(prev), close(node);
    }
    return;
  } else if (flags & Flag.READY) node.flags &= ~Flag.READY;
  for (let link = node.deps; link; link = link.dep_next) {
    link.dep.flags & Flag.QUEUE && run(link.dep, link.dep.flags &= ~Flag.QUEUE);
  }
};
const queue: (ReactiveNode | undefined)[] = [];
const notify = (to: ReactiveNode) => {
  to.flags & Flag.QUEUE || (
    to.flags |= Flag.QUEUE, to.subs ? notify(to.subs.sub) : queue[size++] = to
  );
};
const all = () => {
  for (let next; z < size; ++z) {
    run(next = queue[z]!, next.flags &= ~Flag.QUEUE), queue[z] = undefined;
  }
  z = size = 0;
};
// The passed-in value is a one-item rest parameter, whose length differentiates
// explicit `undefined` from an omitted parameter. (This signature's `value`
// isn't optional but the exposed `signal` function overloads it as such for the
// getter branch.)
function ensignal<A>(this: SignalNode<A>, ...value: [A]) {
  if (value.length) { // as setter
    if (this.has !== (this.has = value[0])) {
      this.flags = Flag.RESET, this.subs && (deep(this.subs), depth) || all();
    }
  } else { // as getter
    this.flags & Flag.DIRTY && resignal(this, this.has) && this.subs &&
    shallow(this.subs), point && enlink(this, point);
  }
  return this.has; // hehe
}
function encached<A>(this: CachedNode<A>) {
  if (
    this.flags & Flag.DIRTY || this.flags & Flag.READY && dirt(this.deps!, this)
  ) recached(this) && this.subs && shallow(this.subs);
  else if (this.flags & Flag.READY) this.flags &= ~Flag.READY;
  if (point) enlink(this, point);
  else if (scope) enlink(this, scope);
  return this.has!; // now that it's run once, the value is there
}
let z = 0, size = 0, depth = 0;
let point: ReactiveNode | undefined, scope: ScoperNode | undefined;
/** Manually sets the current subscriber (for testing). */
export const set_point = (to?: ReactiveNode): ReactiveNode | undefined => {
  const prev = point;
  return point = to, prev;
};
/** Starts a batched update, suspending recomputation until `debatch`ed. */
export const enbatch = (): number => ++depth;
/** Ends a batched update (if any), running all pending computations. */
export const debatch = (): false | void => !--depth && all();
/** Reactive value. */
export type Signal<A> = { (): A; <B extends A>(value: B): B };
/** Creates a reactive value. */
export const signal = ((initial?: unknown) =>
  ensignal.bind({
    kind: Kind.SIGNAL,
    head: undefined,
    deps: undefined,
    subs: undefined,
    tail: undefined,
    flags: Flag.MAYBE,
    old: initial,
    has: initial,
  })) as {
    <A>(): Signal<A | undefined>;
    <A>(initial: A): Signal<A>;
  };
/** Derived computation. */
export type Cached<A> = () => A;
/** Creates a derived computation. */
export const cached =
  ((get: (old?: unknown) => unknown, initial?: unknown) =>
    encached.bind({
      kind: Kind.CACHED,
      head: undefined,
      deps: undefined,
      subs: undefined,
      tail: undefined,
      flags: Flag.RESET,
      get, // <https://github.com/microsoft/TypeScript/issues/47599>
      has: initial,
    })) as {
      <A>(get: (old?: A) => A): Cached<A>;
      <A>(get: (old: A) => A, initial: A): Cached<A>;
    };
/** Creates a side-effect. */
export const effect = (run: () => void): () => void => {
  const node: EffectNode = {
    kind: Kind.EFFECT,
    head: undefined,
    deps: undefined,
    subs: undefined,
    tail: undefined,
    flags: Flag.WATCH,
    run,
  };
  if (point) enlink(node, point);
  else if (scope) enlink(node, scope);
  const prev = set_point(node);
  try {
    node.run();
  } finally {
    set_point(prev);
  }
  return dispose.bind(node);
};
/** Creates a disposable effect group. */
export const scoper = (run: () => void): () => void => {
  const node: ScoperNode = {
    kind: Kind.SCOPER,
    head: undefined,
    deps: undefined,
    subs: undefined,
    tail: undefined,
    flags: 0,
  };
  scope && enlink(node, scope);
  const prev_point = set_point(undefined), prev_scope = scope;
  scope = node;
  try {
    run();
  } finally {
    set_point(prev_point), scope = prev_scope;
  }
  return dispose.bind(node);
};
