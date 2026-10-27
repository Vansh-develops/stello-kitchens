// English — the source catalogue for the diner app. Other locales are typed
// against it; `{name}` marks an interpolated value.
export const en = {
  "common.language": "Language",
  "common.combo": "COMBO",
  "common.add": "Add",
  "common.addAmount": "Add · {amount}",
  "common.soldOut": "Sold out",

  "landing.title": "Scan to order",
  "landing.body":
    "Point your camera at the QR code on your table to browse the menu and order without waiting for a server.",

  "menu.loading": "Loading the menu…",
  "menu.loadFailed": "Could not load the menu",
  "menu.oops": "Hmm.",
  "menu.table": "Table {name}",
  "menu.takeaway": "Takeaway",
  "menu.headline": "What are you craving?",
  "menu.callServer": "Call a server",
  "menu.serverComing": "A server is on the way ✓",
  "menu.callWater": "Water",
  "menu.callBill": "Bill",
  "menu.onTheWay": "On the way ✓",
  "menu.toChoose": "{count} to choose",
  "menu.from": "from {price}",
  "menu.customisable": "customisable",
  "menu.itemsOne": "1 item",
  "menu.itemsMany": "{count} items",
  "menu.review": "Review order · {amount}",

  "cart.title": "Your order",
  "cart.namePlaceholder": "Your name (optional)",
  "cart.phonePlaceholder": "Phone (optional)",
  "cart.send": "Send to kitchen · {amount}",
  "cart.fineprint": "A server will confirm your order before it's prepared.",
  "cart.failed": "Could not place your order",

  "config.chooseOne": "Choose one",
  "config.upTo": " · up to {count}",
  "config.soldOutTag": " (sold out)",

  "confirm.sentTitle": "Sent to the counter",
  "confirm.sentBody": "A server is confirming your order. Hang tight — this is usually quick.",
  "confirm.tokenLabel": "Your token",
  "confirm.okTitle": "Order confirmed",
  "confirm.okBody": "We're preparing it now. Watch for your token on the screen.",
  "confirm.more": "Order more",
  "confirm.noTitle": "Order not confirmed",
  "confirm.noBody": "The counter couldn't take this order. Please check with a server.",
  "confirm.startOver": "Start over",

  "board.loading": "Loading…",
  "board.unavailable": "Board unavailable",
  "board.status": "Order status",
  "board.preparing": "Preparing",
  "board.ready": "Ready to collect",

  "install.region": "Install app",
  "install.text": "Run this screen full-screen as an app.",
  "install.button": "Install app",
  "install.ios": "To install, tap Share → Add to Home Screen.",
  "install.dismiss": "Dismiss",
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
