// The Rivet client. The server gives the browser its endpoint and a
// short-lived token, so no secret is in the page.

import { Client } from "@rivetkit/effect";
import { Effect, Layer, Schema } from "effect";
import { Counter, Order } from "../../shared/api.ts";
import { COUNTER_KEY } from "./constant.ts";

const ClientConfig = Schema.Struct({
	endpoint: Schema.String,
	namespace: Schema.String,
});

/** The server builds `/config.json` from its environment at runtime. */
const fetchClientConfig = Effect.tryPromise(() =>
	fetch("/config.json").then((response) => response.json()),
).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ClientConfig)));

/**
 * The server issues a short-lived token for the browser. The token is `null`
 * when the control plane needs none, for example a local one.
 */
const fetchToken = async (forceRefresh: boolean): Promise<string | null> => {
	const response = await fetch(forceRefresh ? "/token?refresh" : "/token");
	if (!response.ok) throw new Error(`/token answered ${response.status}`);
	const { token } = (await response.json()) as { token: string | null };
	return token;
};

/**
 * `getToken` must resolve to a nonempty string, so it cannot say "no token".
 * The first read of `/token` decides if the client gets a `getToken` at all.
 */
const getToken: NonNullable<Client.Options["getToken"]> = async ({
	forceRefresh,
}) => {
	const token = await fetchToken(forceRefresh);
	if (token === null) throw new Error("/token has no token");
	return token;
};

/** One Rivet client for the app. A config that cannot load crashes the app. */
export const clientLayer = Layer.unwrap(
	Effect.gen(function* () {
		const config = yield* fetchClientConfig;
		const token = yield* Effect.tryPromise(() => fetchToken(false));
		return Client.layer(token === null ? config : { ...config, getToken });
	}).pipe(Effect.orDie),
);

export const counter = Counter.client.pipe(
	Effect.map((client) => client.getOrCreate(COUNTER_KEY)),
);

/** Gives a handle to the order with a key. */
export const order = Order.client.pipe(
	Effect.map((client) => (key: string) => client.getOrCreate(key)),
);
