import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { UrlRequest } from "foldkit/navigation";
import { Url } from "foldkit/url";
import { OrderStep } from "../../shared/api.ts";
import { FeedEvent } from "./model.ts";

export const Message = defineMessageUnion({
	// Page
	ClickedLink: { request: UrlRequest },
	ChangedUrl: { url: Url },
	CompletedNavigateInternal: {},
	CompletedLoadExternal: {},
	InteractedWithPage: {},
	ClickedSound: {},
	CompletedSaveSettings: {},
	AcquiredSpeaker: {},
	ReleasedSpeaker: {},
	FailedAcquireSpeaker: { error: Schema.String },
	CompletedPlayCue: {},
	TimestampedFeedEvent: { event: FeedEvent },

	// Counter
	ClickedIncrement: {},
	ClickedBurst: {},
	ClickedOpenClient: {},
	CompletedOpenClient: {},
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
	CompletedReloadPage: {},
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
