import { NodeRuntime } from "@effect/platform-node";
import { Registry } from "@rivetkit/effect";
import { Layer } from "effect";
import { CounterLive } from "./counter.ts";
import { AppServerLive, MetricsServerLive } from "./http.ts";
import { OrderLive } from "./order.ts";

/**
 * The cluster sets RIVET_ENDPOINT, RIVET_TOKEN, RIVET_NAMESPACE, RIVET_POOL
 * and the node version. `pnpm start:local` sets RIVET_RUN_ENGINE=1 instead.
 */
const RegistryLive = Registry.layer({ startServices: false, runtime: "native" });

const MainLive = Layer.mergeAll(
	Registry.serve(Layer.mergeAll(CounterLive, OrderLive)),
	AppServerLive,
	MetricsServerLive,
).pipe(Layer.provide(RegistryLive));

Layer.launch(MainLive).pipe(NodeRuntime.runMain);
