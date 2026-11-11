import { NodeRuntime } from "@effect/platform-node";
import { Registry } from "@rivetkit/effect";
import { Layer } from "effect";
import { CounterLive } from "./counter.ts";
import { HttpLive } from "./http.ts";
import { OrderLive } from "./order.ts";

// `Registry.layer()` reads RIVET_ENDPOINT, RIVET_TOKEN and RIVET_NAMESPACE.
const ActorsLive = Registry.serve(Layer.mergeAll(CounterLive, OrderLive)).pipe(
	Layer.provide(Registry.layer()),
);

Layer.launch(Layer.mergeAll(HttpLive, ActorsLive)).pipe(NodeRuntime.runMain);
