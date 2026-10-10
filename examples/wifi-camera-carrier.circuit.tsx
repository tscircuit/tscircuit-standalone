/**
 * Standalone runtime qualification: a socket carrier for an ESP32-CAM board.
 * The inserted module supplies ESP32 Wi-Fi, PSRAM, flash and an OV2640 camera.
 * This is locally authored connector geometry, not a catalog component or
 * a production-qualified module footprint. Hole positions and signal order
 * follow the Ai-Thinker ESP32-CAM datasheet. Each header has its own
 * bottom-to-top pin numbering, rather than manufacturer module pin numbers.
 * The full module body, antenna keepout and camera optics are not modeled.
 *
 * Supply J_POWER with regulated 5 V. J_UART uses 3.3 V logic only: adapter TX
 * connects to CAM_RX and adapter RX to CAM_TX. Close J_BOOT and power-cycle
 * the module to program it, then open the jumper: GPIO0 is camera XCLK in
 * operation. The carrier adds no camera bus or RF circuitry. GPIO12-15 are
 * brought out for diagnostics; don't drive them while using module microSD.
 */
export default function WifiCameraCarrierCircuit() {
  return (
    <board width="50mm" height="55mm" schLayout={{ layoutMode: "relative" }}>
      <schematicsheet name="ESP32-CAM socket carrier qualification" sheetWidth="297mm" sheetHeight="210mm">
        <net name="V5V" isPowerNet />
        <net name="V3V3" isPowerNet />
        <net name="GND" isGroundNet />

        <pinheader
          name="J_CAM_LEFT"
          pinCount={8}
          gender="female"
          footprint="pinrow8_p2.54mm_female_id1mm_od1.8mm"
          pcbX={-11.43}
          pcbY={3}
          pcbRotation={90}
          schX={-1.8}
          schY={0}
          pinLabels={["V5V", "GND_LEFT", "IO12", "IO13", "IO15", "IO14", "IO2", "IO4"]}
          schPinArrangement={{ rightSide: { pins: ["pin8", "pin7", "pin6", "pin5", "pin4", "pin3", "pin2", "pin1"], direction: "top-to-bottom" } }}
        />
        <pinheader
          name="J_CAM_RIGHT"
          pinCount={8}
          gender="female"
          footprint="pinrow8_p2.54mm_female_id1mm_od1.8mm"
          pcbX={11.43}
          pcbY={3}
          pcbRotation={90}
          schX={1.8}
          schY={0}
          pinLabels={["V3V3", "PSRAM_IO16", "BOOT_IO0", "GND_RIGHT", "VCC_LINK", "CAM_RX", "CAM_TX", "GND_UART"]}
          schPinArrangement={{ rightSide: { pins: ["pin8", "pin7", "pin6", "pin5", "pin4", "pin3", "pin2", "pin1"], direction: "top-to-bottom" } }}
        />

        <pinheader name="J_POWER" pinCount={2} pinLabels={["V5V", "GND"]}
          footprint="pinrow2_p2.54mm_id1mm_od1.8mm" pcbX={-11} pcbY={-20} schX={-5} schY={3.8} />
        <pinheader name="J_UART" pinCount={3} pinLabels={["GND", "CAM_RX", "CAM_TX"]}
          footprint="pinrow3_p2.54mm_id1mm_od1.8mm" pcbX={11} pcbY={-20} schX={5.8} schY={-2.5} />
        <pinheader name="J_BOOT" pinCount={2} pinLabels={["BOOT_IO0", "GND"]}
          footprint="pinrow2_p2.54mm_id1mm_od1.8mm" pcbX={12} pcbY={-14} schX={5.8} schY={0.8} />
        <pinheader name="J_GPIO" pinCount={6} pinLabels={["IO12", "IO13", "IO14", "IO15", "V3V3", "GND"]}
          footprint="pinrow6_p2.54mm_id1mm_od1.8mm" pcbX={-21} pcbY={0} pcbRotation={90} schX={-5.8} schY={-2.5} />

        <capacitor name="C_BULK" capacitance="10uF" footprint="0805" pcbX={-12} pcbY={-14} schX={-4.3} schY={1.4} schRotation={270} />
        <capacitor name="C_DECOUPLE" capacitance="100nF" footprint="0603" pcbX={-7} pcbY={-14} schX={-6.5} schY={1.4} schRotation={270} />
        <resistor name="R_BOOT" resistance="10k" footprint="0603" pcbX={12} pcbY={-9} schX={4.3} schY={2.4} schRotation={270} />
        <resistor name="R_STATUS" resistance="2.2k" footprint="0603" pcbX={-3} pcbY={-20} schX={4.3} schY={4.7} />
        <led name="D_STATUS" color="green" footprint="0603" pcbX={2} pcbY={-20} schX={7} schY={4.7} />

        <trace thickness="0.5mm" name="POWER_INPUT" from=".J_POWER > .V5V" to="net.V5V" schDisplayLabel="5V" />
        <trace name="POWER_GROUND" from=".J_POWER > .GND" to="net.GND" schDisplayLabel="GND" />
        <trace thickness="0.5mm" name="MODULE_POWER" from=".J_CAM_LEFT > .V5V" to="net.V5V" schDisplayLabel="5V" />
        <trace name="MODULE_3V3_OUTPUT" from=".J_CAM_RIGHT > .V3V3" to="net.V3V3" schDisplayLabel="3V3" />
        <trace name="MODULE_GROUND_LEFT" from=".J_CAM_LEFT > .GND_LEFT" to="net.GND" schDisplayLabel="GND" />
        <trace name="MODULE_GROUND_RIGHT" from=".J_CAM_RIGHT > .GND_RIGHT" to="net.GND" schDisplayLabel="GND" />
        <trace name="MODULE_GROUND_UART" from=".J_CAM_RIGHT > .GND_UART" to="net.GND" schDisplayLabel="GND" />
        <trace thickness="0.5mm" name="BULK_POWER" from=".C_BULK > .pin1" to="net.V5V" schDisplayLabel="5V" />
        <trace name="BULK_GROUND" from=".C_BULK > .pin2" to="net.GND" schDisplayLabel="GND" />
        <trace thickness="0.5mm" name="DECOUPLE_POWER" from=".C_DECOUPLE > .pin1" to="net.V5V" schDisplayLabel="5V" />
        <trace name="DECOUPLE_GROUND" from=".C_DECOUPLE > .pin2" to="net.GND" schDisplayLabel="GND" />
        <trace name="UART_GROUND" from=".J_UART > .GND" to="net.GND" schDisplayLabel="GND" />
        <trace name="UART_RECEIVE" from=".J_CAM_RIGHT > .CAM_RX" to=".J_UART > .CAM_RX" />
        <trace name="UART_TRANSMIT" from=".J_CAM_RIGHT > .CAM_TX" to=".J_UART > .CAM_TX" />
        <trace name="BOOT_GROUND" from=".J_BOOT > .GND" to="net.GND" schDisplayLabel="GND" />
        <trace name="BOOT_SELECT" from=".J_CAM_RIGHT > .BOOT_IO0" to=".J_BOOT > .BOOT_IO0" />
        <trace name="BOOT_PULLUP_POWER" from=".R_BOOT > .pin1" to="net.V3V3" schDisplayLabel="3V3" />
        <trace name="BOOT_PULLUP_SIGNAL" from=".R_BOOT > .pin2" to=".J_CAM_RIGHT > .BOOT_IO0" />
        <trace name="STATUS_POWER" from=".R_STATUS > .pin1" to="net.V3V3" schDisplayLabel="3V3" />
        <trace name="STATUS_LED" from=".R_STATUS > .pin2" to=".D_STATUS > .anode" />
        <trace name="STATUS_GROUND" from=".D_STATUS > .cathode" to="net.GND" schDisplayLabel="GND" />
        <trace name="GPIO_12" from=".J_CAM_LEFT > .IO12" to=".J_GPIO > .IO12" />
        <trace name="GPIO_13" from=".J_CAM_LEFT > .IO13" to=".J_GPIO > .IO13" />
        <trace name="GPIO_14" from=".J_CAM_LEFT > .IO14" to=".J_GPIO > .IO14" />
        <trace name="GPIO_15" from=".J_CAM_LEFT > .IO15" to=".J_GPIO > .IO15" />
        <trace name="GPIO_3V3" from=".J_GPIO > .V3V3" to="net.V3V3" schDisplayLabel="3V3" />
        <trace name="GPIO_GROUND" from=".J_GPIO > .GND" to="net.GND" schDisplayLabel="GND" />
      </schematicsheet>
    </board>
  )
}
