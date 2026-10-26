import { render } from "solid-js/web";

import { App } from "./App";

import "./styles.css";
import "./ui/layout-themes.css";
import "./ui/mobile-layout.css";
import "./data/layoutTheme";
import "./data/mobileViewport";

render(() => <App />, document.getElementById("root")!);
