import { Menu } from "./Menu";
import { Board } from "./Board";

// Tiny path router — the diner app is only ever opened via a QR deep link, so
// a full router dependency would be overkill.
export function App() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  const [route, token] = parts;

  if (route === "t" && token) return <Menu mode="table" token={token} />;
  if (route === "kiosk" && token) return <Menu mode="kiosk" token={token} />;
  if (route === "board" && token) return <Board token={token} />;

  return (
    <div className="landing">
      <div className="mark">Spice Route</div>
      <h1>Scan to order</h1>
      <p>
        Point your camera at the QR code on your table to browse the menu and order without
        waiting for a server.
      </p>
    </div>
  );
}
