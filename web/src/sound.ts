// Short synthesized sounds, made from oscillators and noise. No audio files.
// Every sound is quiet and short: a tick for an action, a mallet note for a
// result, and a chord when an order ships. A short room reverb, made from
// decaying noise, gives the notes a little space.

import { UiSchema } from "@effect/ui";
import { Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect";

/** What a sound is for. `degree` picks a note of the scale, so a run of results climbs. */
export const Cue = UiSchema.TaggedEnum({
	Tick: {},
	Note: { degree: Schema.Number },
	Echo: { degree: Schema.Number },
	Chord: {},
	PowerDown: {},
});
export type Cue = typeof Cue.Type;

/** An open `AudioContext` and the node every sound plays into. */
export type SpeakerNodes = {
	readonly context: AudioContext;
	/** Plays dry and into the reverb. */
	readonly output: AudioNode;
	readonly noise: AudioBuffer;
};

/** How long the reverb rings, and how much of it mixes in. */
const ROOM_SECONDS = 1.4;
const ROOM_LEVEL = 0.22;

/** A stereo impulse of noise that decays to silence: a small, soft room. */
const roomImpulse = (context: AudioContext) => {
	const length = Math.round(context.sampleRate * ROOM_SECONDS);
	const impulse = context.createBuffer(2, length, context.sampleRate);
	for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
		const samples = impulse.getChannelData(channel);
		for (let index = 0; index < length; index++) {
			const left = 1 - index / length;
			samples[index] = (Math.random() * 2 - 1) * left ** 3;
		}
	}
	return impulse;
};

/**
 * Waits until the browser is idle. The first `AudioContext` of a page takes
 * Chrome over 100 ms to set up, so the speaker opens after the press that
 * allowed it has drawn its frame, not inside that press. The press still
 * counts as user activation, so the context starts.
 */
const whenIdle = Effect.callback<void>((resume) => {
	if (typeof requestIdleCallback === "function") {
		const id = requestIdleCallback(() => resume(Effect.void), {
			timeout: 500,
		});
		return Effect.sync(() => cancelIdleCallback(id));
	}
	const id = setTimeout(() => resume(Effect.void), 50);
	return Effect.sync(() => clearTimeout(id));
});

/**
 * The open speaker, if any. `holdSpeaker` opens it while it runs, and
 * `PlayCue` plays into it. A cue while it is closed plays nothing.
 */
export class Speaker extends Context.Service<
	Speaker,
	{ readonly current: Ref.Ref<Option.Option<SpeakerNodes>> }
>()("Speaker") {
	static readonly layer = Layer.effect(
		Speaker,
		Effect.map(Ref.make(Option.none<SpeakerNodes>()), (current) => ({
			current,
		})),
	);
}

const createSpeaker = (): SpeakerNodes => {
	const context = new AudioContext();
	const output = context.createGain();
	output.gain.value = 0.8;
	const limiter = context.createDynamicsCompressor();
	limiter.connect(context.destination);
	output.connect(limiter);

	const room = context.createConvolver();
	room.buffer = roomImpulse(context);
	const roomLevel = context.createGain();
	roomLevel.gain.value = ROOM_LEVEL;
	output.connect(room).connect(roomLevel).connect(limiter);

	const noise = context.createBuffer(
		1,
		context.sampleRate / 4,
		context.sampleRate,
	);
	const samples = noise.getChannelData(0);
	for (let index = 0; index < samples.length; index++) {
		samples[index] = Math.random() * 2 - 1;
	}

	return { context, output, noise };
};

/**
 * Opens the speaker and keeps it open until the stream is interrupted, then
 * closes it. Sound is optional, so a speaker that fails to open only logs.
 * The speaker exists while sound is on and the viewer has pressed something
 * on the page. A browser does not start audio before that.
 */
export const holdSpeaker: Stream.Stream<never, never, Speaker> =
	Stream.fromEffect(
		Effect.gen(function* () {
			const { current } = yield* Speaker;
			yield* whenIdle;
			yield* Effect.acquireRelease(
				Effect.try(createSpeaker).pipe(
					Effect.tap((speaker) => Ref.set(current, Option.some(speaker))),
				),
				(speaker) =>
					Ref.set(current, Option.none()).pipe(
						Effect.andThen(Effect.promise(() => speaker.context.close())),
					),
			);
			return yield* Effect.never;
		}).pipe(
			Effect.catch((error) =>
				Effect.logWarning("speaker failed to open", error).pipe(
					Effect.andThen(Effect.never),
				),
			),
			Effect.scoped,
		),
	);

// VOICES

/** C major pentatonic from C4. Any run of these notes sounds like a tune. */
const SCALE = [
	261.63, 293.66, 329.63, 392, 440, 523.25, 587.33, 659.25, 783.99, 880,
];

const noteOf = (degree: number) => SCALE[degree % SCALE.length];

/** A gain that rises in 3 ms and falls to silence by `at + seconds`, so no sound clicks. */
const envelope = (
	speaker: SpeakerNodes,
	at: number,
	seconds: number,
	peak: number,
) => {
	const gain = speaker.context.createGain();
	gain.gain.setValueAtTime(0.0001, at);
	gain.gain.exponentialRampToValueAtTime(peak, at + 0.003);
	gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
	gain.connect(speaker.output);
	return gain;
};

type Tone = {
	readonly type: OscillatorType;
	/** The pitch at the start, which glides to `to` in `glideSeconds`. */
	readonly from: number;
	readonly to: number;
	readonly glideSeconds: number;
	readonly seconds: number;
	readonly peak: number;
};

const tone = (
	speaker: SpeakerNodes,
	at: number,
	{ type, from, to, glideSeconds, seconds, peak }: Tone,
) => {
	const oscillator = speaker.context.createOscillator();
	oscillator.type = type;
	oscillator.frequency.setValueAtTime(from, at);
	oscillator.frequency.exponentialRampToValueAtTime(to, at + glideSeconds);
	oscillator.connect(envelope(speaker, at, seconds, peak));
	oscillator.start(at);
	oscillator.stop(at + seconds + 0.02);
};

/** 10 ms of filtered noise: the soft click of a key. */
const tick = (speaker: SpeakerNodes, at: number) => {
	const source = speaker.context.createBufferSource();
	source.buffer = speaker.noise;
	const filter = speaker.context.createBiquadFilter();
	filter.type = "bandpass";
	filter.frequency.value = 5200;
	filter.Q.value = 0.9;
	source.connect(filter).connect(envelope(speaker, at, 0.01, 0.18));
	source.start(at, 0, 0.03);
};

/**
 * A mallet on a wooden bar: a sine on the pitch, and a quieter partial four
 * times higher that dies away fast. A marimba sounds like this.
 */
const pluck = (
	speaker: SpeakerNodes,
	frequency: number,
	at: number,
	seconds: number,
	peak: number,
) => {
	tone(speaker, at, {
		type: "sine",
		from: frequency,
		to: frequency,
		glideSeconds: 0.01,
		seconds,
		peak,
	});
	tone(speaker, at, {
		type: "sine",
		from: frequency * 4,
		to: frequency * 4,
		glideSeconds: 0.01,
		seconds: seconds / 6,
		peak: peak / 4,
	});
};

const play = (speaker: SpeakerNodes, cue: Cue, at: number) =>
	Cue.match(cue, {
		Tick: () => tick(speaker, at),
		Note: ({ degree }) => {
			tick(speaker, at);
			pluck(speaker, noteOf(degree), at, 0.5, 0.18);
		},
		// The same note from another client: an octave lower and softer.
		Echo: ({ degree }) => pluck(speaker, noteOf(degree) / 2, at, 0.7, 0.14),
		// C, E and G, one after another, so the end of an order rings.
		Chord: () => {
			pluck(speaker, noteOf(5), at, 1.2, 0.14);
			pluck(speaker, noteOf(7), at + 0.08, 1.3, 0.12);
			pluck(speaker, noteOf(8), at + 0.16, 1.6, 0.12);
		},
		// The screen switches off: one note that falls away.
		PowerDown: () =>
			tone(speaker, at, {
				type: "sine",
				from: 660,
				to: 55,
				glideSeconds: 0.3,
				seconds: 0.32,
				peak: 0.12,
			}),
	});

/** Plays `cue` now. A context that the browser has suspended is resumed first. */
export const playCue = (speaker: SpeakerNodes, cue: Cue) =>
	Effect.promise(() =>
		speaker.context.state === "suspended"
			? speaker.context.resume()
			: Promise.resolve(),
	).pipe(
		Effect.andThen(
			Effect.sync(() => play(speaker, cue, speaker.context.currentTime)),
		),
	);
