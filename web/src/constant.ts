/** The key of the one counter that every client shares. */
export const COUNTER_KEY = "demo";

/** The query that marks the counter's second window. */
export const SECOND_WINDOW_QUERY = "window=second";

/** The localStorage key of the saved settings. */
export const SETTINGS_STORAGE_KEY = "settings";

/** How many orders the page keeps, newest first. */
export const MAX_ORDERS = 3;

/** How many `Increment` calls the latency chart shows. */
export const MAX_RECENT_CALLS = 12;

/** How many events the events line keeps, newest first. */
export const MAX_FEED_EVENTS = 3;

/** How many `Increment` calls one burst sends at once. */
export const BURST_SIZE = 10;

/** The wait before a lost connection opens again. */
export const RECONNECT_DELAY = "3 seconds";

/** After a stop, how long past the end of the sleep the page waits before it connects again. */
export const RECONNECT_AFTER_SLEEP_MS = 1500;

/** How long the screen takes to switch off before the page reloads. */
export const POWER_OFF_MS = 320;
