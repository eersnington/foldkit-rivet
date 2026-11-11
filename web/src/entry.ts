import { Runtime } from "foldkit";
import {
	Flags,
	Model,
	flags,
	init,
	resources,
	subscriptions,
	update,
	view,
} from "./main.ts";

const application = Runtime.makeApplication({
	Model,
	Flags,
	init,
	update,
	view,
	subscriptions,
	resources,
	container: document.getElementById("root"),
});

Runtime.run(application, { flags });
