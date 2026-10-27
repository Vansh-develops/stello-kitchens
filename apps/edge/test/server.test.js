"use strict";
// Sidecar HTTP tests: the POS API's sidecar-token + staff-PIN gates, and the LAN
// kitchen display (pairing, ticket API, SSE stream) on real sockets.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createServers } = require("../sidecar/server");
const { activatedEngine } = require("./helpers");

const TOKEN = "test-sidecar-token";
let nextPort = 3119;

async function boot() {
  const ctx = await activatedEngine();
  const servers = createServers(ctx.engine, { sidecarToken: TOKEN, allowedOrigins: new Set(["http://localhost:5175"]), loopOptions: { intervalMs: 60_000 } });
  const listen = (app) => new Promise((resolve) => {
    const port = nextPort++;
    const srv = app.listen(port, "127.0.0.1", () => resolve({ srv, base: `http://127.0.0.1:${port}` }));
  });
  const pos = await listen(servers.app);
  const lan = await listen(servers.lan);
  servers.setLanAddress(lan.srv.address());
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(pos.base + p, { method, headers: { "Content-Type": "application/json", "X-Edge-Token": TOKEN, ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const close = () => {
    servers.loop.stop();
    servers.closeStreams();
    pos.srv.closeAllConnections();
    lan.srv.closeAllConnections();
    pos.srv.close();
    lan.srv.close();
    ctx.engine.close();
  };
  return { ...ctx, servers, pos, lan, call, close };
}

test("POS API needs the sidecar token, a staff PIN session and the right permission", async () => {
  const s = await boot();
  try {
    const anon = await fetch(s.pos.base + "/status");
    assert.equal(anon.status, 401);
    const evil = await fetch(s.pos.base + "/status", { headers: { "X-Edge-Token": TOKEN, Origin: "http://evil.test" } });
    assert.equal(evil.status, 403);

    assert.equal((await s.call("GET", "/status")).status, 200);
    assert.equal((await s.call("POST", "/orders", { items: [{ itemId: "i-fries", quantity: 1 }] })).status, 401);

    const login = await s.call("POST", "/auth/pin", { staffId: "u-cash", pin: "1111" });
    assert.equal(login.status, 200);
    const session = { "X-Staff-Session": login.body.token };
    const created = await s.call("POST", "/orders", { items: [{ itemId: "i-fries", quantity: 1 }], staffId: "someone-else" }, session);
    assert.equal(created.status, 200);
    assert.equal(created.body.createdByStaffId, "u-cash"); // attribution comes from the session, not the body

    // The seeded cashier role has orders.create/settle but not orders.cancel.
    const cancel = await s.call("POST", `/orders/${created.body.clientId}/cancel`, {}, session);
    assert.equal(cancel.status, 403);
    const settled = await s.call("POST", `/orders/${created.body.clientId}/settle`, { payments: [{ mode: "UPI", amount: 63, reference: "UTR1" }] }, session);
    assert.equal(settled.status, 200);
    assert.equal(settled.body.billNo.number, "E01/2627/000001");
    assert.equal(settled.body.closedByStaffId, "u-cash");

    const state = await s.call("GET", "/sync/state", null, session);
    assert.equal(state.body.status.pending, 1);
    const synced = await s.call("POST", "/sync", {}, session);
    assert.equal(synced.status, 200);
    assert.equal(synced.body.pushed, 1);

    await s.call("POST", "/auth/logout", {}, session);
    assert.equal((await s.call("GET", "/orders", null, session)).status, 401);
  } finally {
    s.close();
  }
});

test("LAN KDS: pairing, token-gated tickets, live SSE updates and bumping", async () => {
  const s = await boot();
  try {
    // The LAN listener exposes only the KDS surface.
    assert.equal((await fetch(s.lan.base + "/orders")).status, 404);
    assert.equal((await fetch(s.lan.base + "/")).status, 200);
    assert.equal((await fetch(s.lan.base + "/api/tickets")).status, 401);

    const login = await s.call("POST", "/auth/pin", { staffId: "u-cash", pin: "1111" });
    const session = { "X-Staff-Session": login.body.token };
    const { body: pairing } = await s.call("POST", "/kds/pairing-code", {}, session);
    assert.match(pairing.code, /^\d{6}$/);
    assert.ok(pairing.lan.port > 0);

    const paired = await fetch(s.lan.base + "/api/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: pairing.code, name: "Hot line" }) });
    assert.equal(paired.status, 200);
    const { token } = await paired.json();

    // Open the SSE stream and wait for the order we create next to appear on it.
    const ctrl = new AbortController();
    const stream = await fetch(`${s.lan.base}/api/stream?token=${token}`, { signal: ctrl.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const events = [];
    const pump = (async () => {
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ done: true }));
        if (done) return;
        buf += Buffer.from(value).toString("utf8");
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    })();
    const waitFor = async (pred) => {
      for (let i = 0; i < 100; i++) {
        const hit = events.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("event not received");
    };
    await waitFor((e) => Array.isArray(e.tickets));
    await s.call("POST", "/orders", { orderType: "DINE_IN", tableId: "t1", items: [{ itemId: "i-roll", quantity: 1 }, { itemId: "i-cola", quantity: 2 }] }, session);
    const ev = await waitFor((e) => e.tickets.length === 2);
    assert.deepEqual(ev.tickets.map((t) => t.stationName).sort(), ["Bar", "Hot"]);
    assert.equal(ev.tickets[0].label, "Table T1");

    const tickets = await (await fetch(s.lan.base + "/api/tickets", { headers: { Authorization: `Bearer ${token}` } })).json();
    const bar = tickets.tickets.find((t) => t.stationName === "Bar");
    const bump = await fetch(`${s.lan.base}/api/tickets/${encodeURIComponent(bar.id)}/status`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ status: "READY" }) });
    assert.equal(bump.status, 200);
    await waitFor((e) => e.tickets.some((t) => t.id === bar.id && t.status === "READY"));

    // Revoking the screen cuts it off.
    const screens = (await s.call("GET", "/kds/screens", null, session)).body;
    await s.call("POST", `/kds/screens/${screens[0].id}/revoke`, {}, session);
    assert.equal((await fetch(s.lan.base + "/api/tickets", { headers: { Authorization: `Bearer ${token}` } })).status, 401);
    ctrl.abort();
    await pump;
  } finally {
    s.close();
  }
});
