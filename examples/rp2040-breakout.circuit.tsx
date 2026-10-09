import { PadTestpoint } from "./helpers/pad-testpoint"
import { RP2040 } from "./imports/C2040"

/**
 * Runtime/footprint qualification board, not a production RP2040 reference.
 * External 3.3 V is assumed. Flash, crystal, USB and full per-pin decoupling
 * are deliberately outside this small routing fixture.
 */
export default function Rp2040BreakoutCircuit() {
  return (
    <board
      width="28mm"
      height="26mm"
      schLayout={{ layoutMode: "relative" }}
      schMaxTraceDistance={10}
    >
      <schematicsheet
        name="RP2040 runtime fixture"
        sheetWidth="180mm"
        sheetHeight="160mm"
      >
        <net name="V3V3" isPowerNet />
        <net name="V1V1" isPowerNet />
        <net name="GND" isGroundNet />
        <RP2040
          name="U1"
          schX={0}
          schY={0}
          pcbX={0}
          pcbY={0}
          pinAttributes={{
            IOVDD1: { requiresPower: true },
            IOVDD2: { requiresPower: true },
            IOVDD3: { requiresPower: true },
            IOVDD4: { requiresPower: true },
            IOVDD5: { requiresPower: true },
            IOVDD6: { requiresPower: true },
            ADC_AVDD: { requiresPower: true },
            USB_VDD: { requiresPower: true },
            VREG_IN: { requiresPower: true },
            VREG_VOUT: { providesPower: true },
            DVDD1: { requiresPower: true },
            DVDD2: { requiresPower: true },
            GND: { requiresGround: true },
          }}
        />

        <PadTestpoint name="TP_3V3" schX={-5.5} schY={0.8} pcbX={10} pcbY={7} />
        <PadTestpoint
          name="TP_GND"
          schX={-5.5}
          schY={-0.8}
          pcbX={10}
          pcbY={-7}
        />
        <capacitor
          name="C1"
          schX={4.0}
          schY={1.5}
          schRotation={270}
          capacitance="100nF"
          footprint="0402"
          pcbX={-6}
          pcbY={5}
        />
        <capacitor
          name="C2"
          schX={6.0}
          schY={1.5}
          schRotation={270}
          capacitance="100nF"
          footprint="0402"
          pcbX={6}
          pcbY={3}
        />
        <capacitor
          name="C3"
          schX={4.0}
          schY={-1.5}
          schRotation={270}
          capacitance="1uF"
          footprint="0402"
          pcbX={0}
          pcbY={7}
        />
        <resistor
          name="R_RUN"
          schX={-4.0}
          schY={-2.5}
          resistance="10k"
          footprint="0402"
          pcbX={0}
          pcbY={-6}
        />

        <trace
          name="IOVDD1_SUPPLY"
          from=".U1 > .IOVDD1"
          to="net.V3V3"
          schDisplayLabel="V3V3"
        />
        <trace
          name="IOVDD2_SUPPLY"
          from=".U1 > .IOVDD2"
          to="net.V3V3"
          schDisplayLabel="V3V3"
        />
        <trace
          name="IOVDD3_SUPPLY"
          from=".U1 > .IOVDD3"
          to="net.V3V3"
          schDisplayLabel="V3V3"
        />
        <trace
          name="IOVDD4_SUPPLY"
          from=".U1 > .IOVDD4"
          to="net.V3V3"
          schDisplayLabel="V3V3"
        />
        <trace
          name="IOVDD5_SUPPLY"
          from=".U1 > .IOVDD5"
          to="net.V3V3"
          schDisplayLabel="V3V3"
        />
        <trace
          name="IOVDD6_SUPPLY"
          from=".U1 > .IOVDD6"
          to="net.V3V3"
          schDisplayLabel="V3V3"
        />
        <trace
          name="ADC_SUPPLY"
          from=".U1 > .ADC_AVDD"
          to="net.V3V3"
          schDisplayLabel="V3V3"
        />
        <trace
          name="USB_SUPPLY"
          from=".U1 > .USB_VDD"
          to="net.V3V3"
          schDisplayLabel="V3V3"
        />
        <trace
          name="VREG_INPUT"
          from=".U1 > .VREG_IN"
          to="net.V3V3"
          schDisplayLabel="V3V3"
        />
        <trace
          name="SUPPLY_INPUT"
          from=".TP_3V3 > .pin1"
          to="net.V3V3"
          schDisplayLabel="V3V3"
        />
        <trace
          name="CORE_SUPPLY"
          from=".U1 > .VREG_VOUT"
          to="net.V1V1"
          schDisplayLabel="V1V1"
        />
        <trace
          name="DVDD1_SUPPLY"
          from=".U1 > .DVDD1"
          to="net.V1V1"
          schDisplayLabel="V1V1"
        />
        <trace
          name="DVDD2_SUPPLY"
          from=".U1 > .DVDD2"
          to="net.V1V1"
          schDisplayLabel="V1V1"
        />
        {/* The generated QFN's physical pin57 is the exposed thermal pad. */}
        <trace
          name="THERMAL_GROUND"
          from=".U1 > .GND"
          to="net.GND"
          schDisplayLabel="GND"
        />
        <trace
          name="TESTEN_GROUND"
          from=".U1 > .TESTEN"
          to="net.GND"
          schDisplayLabel="GND"
        />
        <trace
          name="GROUND_INPUT"
          from=".TP_GND > .pin1"
          to="net.GND"
          schDisplayLabel="GND"
        />
        <trace
          name="C1_SUPPLY"
          from=".C1 > .pin1"
          to="net.V3V3"
          schDisplayLabel="V3V3"
        />
        <trace
          name="C1_GROUND"
          from=".C1 > .pin2"
          to="net.GND"
          schDisplayLabel="GND"
        />
        <trace
          name="C2_SUPPLY"
          from=".C2 > .pin1"
          to="net.V3V3"
          schDisplayLabel="V3V3"
        />
        <trace
          name="C2_GROUND"
          from=".C2 > .pin2"
          to="net.GND"
          schDisplayLabel="GND"
        />
        <trace
          name="C3_SUPPLY"
          from=".C3 > .pin1"
          to="net.V1V1"
          schDisplayLabel="V1V1"
        />
        <trace
          name="C3_GROUND"
          from=".C3 > .pin2"
          to="net.GND"
          schDisplayLabel="GND"
        />
        <trace
          name="RUN_PULLUP"
          from=".R_RUN > .pin1"
          to="net.V3V3"
          schDisplayLabel="V3V3"
        />
        <trace name="RUN" from=".R_RUN > .pin2" to=".U1 > .RUN" />

        <PadTestpoint
          name="TP_GPIO0"
          schX={-4.5}
          schY={2.8}
          schRotation={180}
          pcbX={-10}
          pcbY={2}
        />
        <PadTestpoint
          name="TP_GPIO1"
          schX={-4.5}
          schY={2.2}
          schRotation={180}
          pcbX={-10}
          pcbY={-2}
        />
        <PadTestpoint
          name="TP_GPIO25"
          schX={5.5}
          schY={-3.0}
          pcbX={10}
          pcbY={0}
        />
        <PadTestpoint
          name="TP_SWCLK"
          schX={-4.5}
          schY={-1.6}
          schRotation={180}
          pcbX={-2}
          pcbY={-10}
        />
        <PadTestpoint
          name="TP_SWDIO"
          schX={-4.5}
          schY={-2.0}
          schRotation={180}
          pcbX={2}
          pcbY={-10}
        />
        <trace name="GPIO0" from=".U1 > .GPIO0" to=".TP_GPIO0 > .pin1" />
        <trace name="GPIO1" from=".U1 > .GPIO1" to=".TP_GPIO1 > .pin1" />
        <trace name="GPIO25" from=".U1 > .GPIO25" to=".TP_GPIO25 > .pin1" />
        <trace name="SWCLK" from=".U1 > .SWCLK" to=".TP_SWCLK > .pin1" />
        <trace name="SWDIO" from=".U1 > .SWD" to=".TP_SWDIO > .pin1" />
      </schematicsheet>
    </board>
  )
}
