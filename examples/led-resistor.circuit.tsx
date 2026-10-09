import { StatusLed } from "./helpers/status-led"
import { PadTestpoint } from "./helpers/pad-testpoint"

/** A 3.3 V status LED with explicit placement and a local helper import. */
export default function LedResistorCircuit() {
  return (
    <board width="20mm" height="12mm">
      <schematicsheet name="LED" sheetWidth="75mm" sheetHeight="70mm">
        <net name="V3V3" isPowerNet />
        <net name="GND" isGroundNet />
        <StatusLed />
        <PadTestpoint name="TP_3V3" pcbX={-7} pcbY={0} schX={-3} schY={0} />
        <PadTestpoint name="TP_GND" pcbX={7} pcbY={0} schX={6} schY={0} />
        <trace name="SUPPLY_INPUT" from=".TP_3V3 > .pin1" to="net.V3V3" />
        <trace name="LED_SUPPLY" from=".R1 > .pin1" to="net.V3V3" />
        <trace name="LED_GROUND" from=".D1 > .cathode" to="net.GND" />
        <trace name="GROUND_INPUT" from=".TP_GND > .pin1" to="net.GND" />
      </schematicsheet>
    </board>
  )
}
