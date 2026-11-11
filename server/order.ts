import { db, Workflow } from "@rivetkit/effect";
import { Clock, Effect } from "effect";
import { Order, type OrderStatus, StatusChanged } from "../shared/api.ts";

export const OrderLive = Order.toLayer(
	Effect.gen(function* () {
		const sql = yield* Order.sql;
		const events = yield* Order.events;

		/**
		 * Saves a finished step, then tells the connected clients. RivetKit can
		 * run a step again, so the insert keeps the first timestamp.
		 */
		const finish = Effect.fn("Order.finish")(function* (status: OrderStatus) {
			const now = yield* Clock.currentTimeMillis;
			yield* sql`INSERT OR IGNORE INTO steps (status, at) VALUES (${status}, ${now})`;
			const [{ at }] = yield* sql<{
				at: number;
			}>`SELECT at FROM steps WHERE status = ${status}`;
			yield* events.broadcast(StatusChanged, { status, at });
		});

		// The workflow body. The sleeps are short, so a viewer can watch them.
		return Effect.gen(function* () {
			yield* Workflow.step("charge", finish("charged"));
			yield* Workflow.sleep("wait-for-packing", "4 seconds");
			yield* Workflow.step("pack", finish("packed"));
			yield* Workflow.sleep("wait-for-shipping", "4 seconds");
			yield* Workflow.step("ship", finish("shipped"));
		});
	}),
	{
		db: db({
			onMigrate: async (client) => {
				await client.execute(
					"CREATE TABLE IF NOT EXISTS steps (status TEXT PRIMARY KEY, at INTEGER NOT NULL)",
				);
			},
		}),
		actions: Effect.gen(function* () {
			const sql = yield* Order.sql;

			return Order.of({
				GetStatus: () =>
					sql<{
						status: OrderStatus;
						at: number;
					}>`SELECT status, at FROM steps ORDER BY at`.pipe(
						Effect.map((steps) => ({
							status: steps.at(-1)?.status ?? ("new" as const),
							steps,
						})),
						Effect.orDie,
					),
			});
		}),
	},
);
