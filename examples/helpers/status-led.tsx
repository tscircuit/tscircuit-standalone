/** A relative TSX import exercises the standalone evaluator's local resolver. */
export function StatusLed() {
  return (
    <>
      <resistor
        name="R1"
        resistance="1k"
        footprint="0603"
        pcbX={-2}
        pcbY={0}
        schX={0}
        schY={0}
      />
      <led
        name="D1"
        color="green"
        footprint="0603"
        pcbX={2}
        pcbY={0}
        schX={3}
        schY={0}
      />
      <trace name="LED_SIGNAL" from=".R1 > .pin2" to=".D1 > .anode" />
    </>
  )
}
