import { PadTestpoint } from "./helpers/pad-testpoint"
/** Resolve a supplier footprint through the custom platform, without import. */
export default function SupplierFootprintCircuit() {
  return (
    <board width="18mm" height="18mm" schAutoLayoutEnabled>
      <schematicsheet
        name="Supplier footprint fixture"
        sheetWidth="100mm"
        sheetHeight="110mm"
      >
        <chip
          name="U1"
          footprint="jlcpcb:C2040"
          manufacturerPartNumber="RP2040"
          pinLabels={{ pin2: ["GPIO0"], pin57: ["GND", "thermalpad"] }}
        />
        <PadTestpoint name="TP_GPIO0" pcbX={-7} pcbY={2} />
        <PadTestpoint name="TP_GND" pcbX={7} pcbY={-2} />
        <trace name="GPIO0" from=".U1 > .GPIO0" to=".TP_GPIO0 > .pin1" />
        <trace name="THERMAL_GROUND" from=".U1 > .GND" to=".TP_GND > .pin1" />
      </schematicsheet>
    </board>
  )
}
