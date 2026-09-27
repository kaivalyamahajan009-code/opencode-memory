import { render } from "solid-js/web"
import "./index.css"

const root = document.getElementById("root")
if (!root) throw new Error("root missing")

if (location.pathname === "/" || location.pathname === "") {
  history.replaceState(null, "", "/app" + location.search + location.hash)
}

const embed = location.pathname === "/embed" || location.pathname.startsWith("/embed/")

const failed = (e: unknown) => {
  console.error(e)
  root.textContent = "Could not load the Memory dashboard. Reload the page to try again."
}

if (embed) {
  void import("./embed").then((m) => {
    const App = m.EmbedApp
    render(() => <App />, root)
  }, failed)
} else {
  void import("./app-shell").then((m) => {
    const App = m.AppShell
    render(() => <App />, root)
  }, failed)
}
