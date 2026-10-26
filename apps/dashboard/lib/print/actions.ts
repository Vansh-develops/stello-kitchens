import { printApi } from "../print-api";
import { browserPrint, type PrintStation } from "./station";

// One-tap print actions for the POS/KDS. With printers configured they queue a
// server job (so it's logged, routed and reprintable) and nudge this terminal's
// print loop; with no printer set up at all they fall back to printing the same
// document straight from this browser, so "print" always does something.

export async function printBillNow(outletId: string, orderId: string, station: PrintStation) {
  if (station.printers.some((p) => p.isActive && p.printBills)) {
    await printApi.printBill(outletId, orderId);
    station.kick();
    return;
  }
  const bill = await printApi.previewBill(outletId, orderId);
  await browserPrint({ kind: "BILL", bill }, 80);
}

/** After settlement: auto-print jobs exist if a printer is set to; otherwise print now. */
export async function afterSettlePrint(outletId: string, orderId: string, station: PrintStation) {
  if (station.printers.some((p) => p.isActive && p.printBills && p.autoPrintBill)) {
    station.kick();
    return;
  }
  await printBillNow(outletId, orderId, station);
}

export async function reprintKotNow(outletId: string, kotId: string, station: PrintStation) {
  if (station.printers.some((p) => p.isActive && p.printKots)) {
    await printApi.printKot(outletId, kotId);
    station.kick();
    return;
  }
  for (const ticket of await printApi.previewKot(outletId, kotId)) {
    await browserPrint({ kind: "KOT", ticket }, 80);
  }
}
