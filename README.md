# reactivity

Reactive framework for frontend data, derived from
[alien-signals](https://github.com/stackblitz/alien-signals).

```ts
import { cached, effect, scoper, signal } from "@nyoon/reactivity";
import { assertEquals } from "jsr:@std/assert@^1.0.13";

let equals = 1;
const count = signal(equals);
const double_count = cached(() => count() * 2);
const stop = scoper(() => effect(() => assertEquals(count(), equals)));

assertEquals(double_count(), equals * 2);

count(++equals);
assertEquals(double_count(), equals * 2);

stop();
count(3);
```
