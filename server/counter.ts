import { db } from "@rivetkit/effect";
import { Effect } from "effect";
import { CountChanged, Counter } from "../shared/api.ts";

export const CounterLive = Counter.toLayer(
	Effect.gen(function* () {
		const sql = yield* Counter.sql;
		const events = yield* Counter.events;

		return Counter.of({
			Increment: ({ payload }) =>
				sql<{
					count: number;
				}>`UPDATE counter SET count = count + ${payload.amount} WHERE id = 1 RETURNING count`.pipe(
					Effect.map(([{ count }]) => count),
					Effect.orDie,
					Effect.tap((count) =>
						events.broadcast(CountChanged, { count }),
					),
				),
			GetCount: () =>
				sql<{
					count: number;
				}>`SELECT count FROM counter WHERE id = 1`.pipe(
					Effect.map(([{ count }]) => count),
					Effect.orDie,
				),
		});
	}),
	{
		db: db({
			onMigrate: async (client) => {
				await client.execute(
					"CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), count INTEGER NOT NULL)",
				);
				await client.execute(
					"INSERT OR IGNORE INTO counter (id, count) VALUES (1, 0)",
				);
			},
		}),
	},
);
