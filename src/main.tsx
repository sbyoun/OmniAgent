import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// No StrictMode: its dev-only double-mount kills and recreates each pod's
// PTY (and backing tmux session), which breaks session restore.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);

// r3

// r4
