import { Injectable } from "@nestjs/common";
import type { ScaleReadingDto } from "@stello/shared";

/**
 * Seam for peripheral hardware a POS integrates with: weighing scales (weight
 * capture for loose/by-weight items), caller-ID boxes (pop the customer on an
 * incoming call), wireless calling devices, and the digital menu board.
 *
 * Real drivers talk to serial/USB/HID or a vendor SDK on the local terminal.
 * This is a MOCK — the same interface a real driver would implement — so the
 * flows are exercisable without hardware, exactly like the payment gateway.
 */
export interface HardwareBridge {
  /** Read the current weight from a connected scale. */
  readScale(): ScaleReadingDto;
  /** The number ringing in on the caller-ID box, if any. */
  incomingCall(): string | null;
}

@Injectable()
export class MockHardwareBridge implements HardwareBridge {
  // A small pool of plausible incoming numbers for the caller-ID demo.
  private readonly demoNumbers = ["9880012345", "9845567890", "9900011223", "9740098765"];

  readScale(): ScaleReadingDto {
    // Simulate a scale settling around a plate weight (250–750 g).
    const grams = Math.round(250 + Math.random() * 500);
    const stable = Math.random() > 0.25;
    return { grams, stable };
  }

  incomingCall(): string | null {
    return this.demoNumbers[Math.floor(Math.random() * this.demoNumbers.length)];
  }
}

export const HARDWARE_BRIDGE = Symbol("HARDWARE_BRIDGE");
