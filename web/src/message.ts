import { UiSchema } from "@effect/ui";
import { Schema } from "effect";
import { OrderStep } from "../../shared/api.ts";
import { FeedEvent } from "./model.ts";
import { AppRoute } from "./route.ts";

export const Message = UiSchema.TaggedEnum({
	// Page
	ChangedRoute: { route: AppRoute },
	ClickedTab: {},
	InteractedWithPage: {},
	ClickedSound: {},
	TimestampedFeedEvent: { event: FeedEvent },

	// Counter
	ClickedIncrement: {},
	ClickedBurst: {},
	ClickedOpenClient: {},
	SucceededLoadCount: { count: Schema.Number },
	FailedLoadCount: { error: Schema.String },
	SucceededIncrement: {
		count: Schema.Number,
		tookMs: Schema.Number,
		maybeBurstId: Schema.Option(Schema.Number),
	},
	FailedIncrement: { error: Schema.String },
	ConnectedCounter: {},
	ChangedCount: { count: Schema.Number },
	FailedCounterConnection: { error: Schema.String },

	// Order
	ClickedStartOrder: {},
	GeneratedOrderKey: { key: Schema.String },
	ClickedReload: {},
	ClickedStopActor: {},
	SucceededStopActor: { key: Schema.String, stoppedAt: Schema.Number },
	FailedStopActor: { error: Schema.String },
	ConnectedOrder: { key: Schema.String },
	ClickedReconnect: {},
	CompletedWaitForSleepEnd: { key: Schema.String, wakesBefore: Schema.Number },
	SucceededLoadOrder: {
		key: Schema.String,
		steps: Schema.Array(OrderStep),
		wokeAt: Schema.Array(Schema.Number),
		loadedAt: Schema.Number,
	},
	FailedLoadOrder: { error: Schema.String },
	ChangedOrderStatus: { key: Schema.String, step: OrderStep },
	FailedOrderConnection: { key: Schema.String, error: Schema.String },
});
export type Message = typeof Message.Type;
