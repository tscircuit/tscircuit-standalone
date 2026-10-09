import type { CommonLayoutProps } from "@tscircuit/props"

/** 1.2 mm probing pad with a 0.25 mm courtyard clearance on each side. */
export function PadTestpoint(props: CommonLayoutProps & { name: string }) {
  return (
    <testpoint
      footprintVariant="pad"
      padShape="circle"
      padDiameter="1.2mm"
      doNotPlace
      {...props}
    >
      <courtyardrect width="1.7mm" height="1.7mm" />
    </testpoint>
  )
}
