import { Fragment } from "react"
import { ESP32_S3R8 } from "./imports/C2913194"
import { W25Q128JVSIQ } from "./imports/C97521"
import { AP2112K_3_3TRG1 } from "./imports/C23380830"
import { USBLC6_2P6 } from "./imports/C2827693"
import { TYPE_C_16PIN_2MD_073_ } from "./imports/C2765186"
import { SM02B_PASS_TBT_LF__SN_ } from "./imports/C265417"
import { FH12_24S_0_5SH_55_ } from "./imports/C202112"
import { X322540MMB4SI } from "./imports/C5210647"
import { ME6211C28M5G_N } from "./imports/C53099"
import { TLV70013DDCR } from "./imports/C2868517"
import { U_FL_R_SMT_1_10_ } from "./imports/C88373"

/**
 * Bare ESP32-S3 camera controller for standalone runtime qualification.
 * The ESP32-S3R8 is a QFN IC with in-package PSRAM, not a Wi-Fi module.
 * External flash, 40 MHz crystal, regulator, USB protection and connectors
 * are represented individually. The camera optics/sensor are external.
 *
 * J_CAMERA follows the OV2640 24-contact interface in the Ai-Thinker
 * ESP32-CAM reference: 8-bit DVP Y2..Y9, 3.3 V digital I/O, 2.8 V analog
 * and 1.3 V core rails. The mating flex contact side still needs review.
 * J_AUX_3V3 is a regulated power OUTPUT, never a second 5 V input.
 * J_DEBUG uses 3.3 V UART logic. The GPIO header avoids the PSRAM pins.
 * RF matching, crystal loading, controlled impedances, ground planes,
 * thermal relief and regulator current/thermal budget need hardware review.
 * The RF output connects to a compact imported U.FL antenna connector.
 * The RF matching values are starting values and require antenna tuning.
 * This is a runtime/footprint integration fixture, not a manufacturing file.
 */

const caps = [
  ["C_USB", "1uF", "VBUS", -28, -19, -12.5, 4],
  ["C_LDO_IN", "1uF", "VBUS", -21, -13, -10.5, 4],
  ["C_LDO_OUT", "10uF", "V3V3", -13, -13, -8.5, 4],
  ["C_RF1", "100nF", "V3V3", -6.5, 0, -6.5, 5.5],
  ["C_RF2", "10uF", "V3V3", -13, 5.5, -5, 5.5],
  ["C_RTC", "100nF", "V3V3", -4, -7.5, -3.5, 5.5],
  ["C_CPU", "100nF", "V3V3", 5.5, 8, -2, 5.5],
  ["C_ANALOG1", "100nF", "V3V3", -7.5, 8, -0.5, 5.5],
  ["C_ANALOG2", "1uF", "V3V3", -10.5, 8, 1, 5.5],
  ["C_FLASH", "100nF", "VDD_SPI", 15, 7, 8.5, -5.5],
  ["C_SPI", "1uF", "VDD_SPI", 7, -4, 10, -5.5],
  ["C_EN", "1uF", "CHIP_EN", -12, 1, -7, -3.5],
  ["C_CAMERA", "10uF", "V3V3", -12, 18, 9, 2],
  ["C_CAMERA_HF", "100nF", "V3V3", -7, 18, 10.5, 2],
  ["C_CAM_AVDD", "1uF", "CAM_AVDD", 12, 18, 12.5, 4],
  ["C_CAM_DVDD", "1uF", "CAM_DVDD", 19, 18, 14, 4],
  ["C_CAM_AVDD_IN", "1uF", "V3V3", 10, 15, 12.5, 5.5],
  ["C_CAM_DVDD_IN", "1uF", "V3V3", 17, 15, 14, 5.5],
  ["C_SPI_HF", "100nF", "VDD_SPI", 7, -8, 11.5, -5.5],
] as const

const resistors = [
  ["R_CC1", "5.1k", "CC1", "GND", -33, -23.5, -14.5, -4],
  ["R_CC2", "5.1k", "CC2", "GND", -21, -23.5, -12.5, -4],
  ["R_USB_DM", "22", "USB_DM_PROTECTED", "USB_DM", 0, -5.5, -10, -1.5],
  ["R_USB_DP", "22", "USB_DP_PROTECTED", "USB_DP", 3.5, -5.5, -10, -2.5],
  ["R_EN", "10k", "V3V3", "CHIP_EN", -9, -4, -7, -2],
  ["R_BOOT", "10k", "V3V3", "BOOT", -9, -1, -7, -5],
  ["R_FLASH_CS", "10k", "VDD_SPI", "FLASH_CS", 10, 7, 6.5, -5.5],
  ["R_SCCB_SDA", "4.7k", "V3V3", "CAM_SDA", -4, 18, 8.5, 4],
  ["R_SCCB_SCL", "4.7k", "V3V3", "CAM_SCL", -1, 18, 10.5, 4],
  ["R_GPIO45", "10k", "GPIO45", "GND", -1, 12, -3.5, -7.5],
  ["R_GPIO46", "10k", "GPIO46", "GND", 3, 12, -1.5, -7.5],
  ["R_LED", "2.2k", "STATUS", "LED_ANODE", 24, -18, 11.5, -8],
  ["R_CAM_PWDN", "10k", "CAM_PWDN", "GND", -4, 14, 12.5, 1.5],
  ["R_CAM_RESET", "10k", "V3V3", "CAM_RESET", 4, 18, 14, 1.5],
] as const

/** Physical pins, independent of the component aliases used in symbols. */
const nets: Record<string, readonly (readonly [string, number])[]> = {
  VBUS: [
    ["J_USB_C", 16],
    ["J_USB_C", 25],
    ["U_USB_ESD", 5],
    ["U_LDO", 1],
    ["U_LDO", 3],
  ],
  V3V3: [
    ["U_LDO", 5],
    ["U_MCU", 2],
    ["U_MCU", 3],
    ["U_MCU", 20],
    ["U_MCU", 46],
    ["U_MCU", 55],
    ["U_MCU", 56],
    ["J_CAMERA", 14],
    ["U_CAM_ANALOG", 1],
    ["U_CAM_ANALOG", 3],
    ["U_CAM_CORE", 1],
    ["U_CAM_CORE", 3],
    ["J_AUX_3V3", 1],
    ["J_DEBUG", 1],
    ["J_GPIO", 1],
  ],
  VDD_SPI: [
    ["U_MCU", 29],
    ["U_FLASH", 8],
  ],
  CAM_AVDD: [
    ["U_CAM_ANALOG", 5],
    ["J_CAMERA", 21],
  ],
  CAM_DVDD: [
    ["U_CAM_CORE", 5],
    ["J_CAMERA", 15],
  ],
  GND: [
    ["U_MCU", 57],
    ["U_FLASH", 4],
    ["U_LDO", 2],
    ["U_USB_ESD", 2],
    ["J_USB_C", 13],
    ["J_USB_C", 14],
    ["J_USB_C", 15],
    ["J_USB_C", 26],
    ["J_AUX_3V3", 2],
    ["J_CAMERA", 10],
    ["J_CAMERA", 23],
    ["U_CAM_ANALOG", 2],
    ["U_CAM_CORE", 2],
    ["J_CAMERA", 25],
    ["J_CAMERA", 26],
    ["J_DEBUG", 2],
    ["J_GPIO", 2],
    ["SW_BOOT", 2],
    ["SW_BOOT", 4],
    ["SW_RESET", 2],
    ["SW_RESET", 4],
    ["Y_MAIN", 2],
    ["Y_MAIN", 4],
  ],
  CC1: [["J_USB_C", 18]],
  CC2: [["J_USB_C", 24]],
  USB_DM_PROTECTED: [
    ["J_USB_C", 19],
    ["J_USB_C", 21],
    ["U_USB_ESD", 1],
    ["U_USB_ESD", 6],
  ],
  USB_DP_PROTECTED: [
    ["J_USB_C", 20],
    ["J_USB_C", 22],
    ["U_USB_ESD", 3],
    ["U_USB_ESD", 4],
  ],
  USB_DM: [["U_MCU", 25]],
  USB_DP: [["U_MCU", 26]],
  CHIP_EN: [
    ["U_MCU", 4],
    ["SW_RESET", 1],
    ["SW_RESET", 3],
    ["J_DEBUG", 5],
  ],
  BOOT: [
    ["U_MCU", 5],
    ["SW_BOOT", 1],
    ["SW_BOOT", 3],
    ["J_DEBUG", 6],
  ],
  GPIO45: [["U_MCU", 51]],
  GPIO46: [["U_MCU", 52]],
  FLASH_CS: [
    ["U_MCU", 32],
    ["U_FLASH", 1],
  ],
  FLASH_CLK: [
    ["U_MCU", 33],
    ["U_FLASH", 6],
  ],
  FLASH_D0: [
    ["U_MCU", 35],
    ["U_FLASH", 5],
  ],
  FLASH_D1: [
    ["U_MCU", 34],
    ["U_FLASH", 2],
  ],
  FLASH_D2: [
    ["U_MCU", 31],
    ["U_FLASH", 3],
  ],
  FLASH_D3: [
    ["U_MCU", 30],
    ["U_FLASH", 7],
  ],
  XTAL_P: [
    ["U_MCU", 54],
    ["L_XTAL", 1],
  ],
  XTAL_P_CRYSTAL: [
    ["L_XTAL", 2],
    ["Y_MAIN", 1],
    ["C_XTAL_P", 1],
  ],
  XTAL_N: [
    ["U_MCU", 53],
    ["Y_MAIN", 3],
    ["C_XTAL_N", 1],
  ],
  CAM_D0: [
    ["U_MCU", 9],
    ["J_CAMERA", 6],
  ],
  CAM_D1: [
    ["U_MCU", 10],
    ["J_CAMERA", 4],
  ],
  CAM_D2: [
    ["U_MCU", 11],
    ["J_CAMERA", 3],
  ],
  CAM_D3: [
    ["U_MCU", 12],
    ["J_CAMERA", 5],
  ],
  CAM_D4: [
    ["U_MCU", 13],
    ["J_CAMERA", 7],
  ],
  CAM_D5: [
    ["U_MCU", 14],
    ["J_CAMERA", 9],
  ],
  CAM_D6: [
    ["U_MCU", 15],
    ["J_CAMERA", 11],
  ],
  CAM_D7: [
    ["U_MCU", 16],
    ["J_CAMERA", 13],
  ],
  CAM_PCLK: [
    ["U_MCU", 17],
    ["J_CAMERA", 8],
  ],
  CAM_VSYNC: [
    ["U_MCU", 18],
    ["J_CAMERA", 18],
  ],
  CAM_HREF: [
    ["U_MCU", 19],
    ["J_CAMERA", 16],
  ],
  CAM_XCLK: [
    ["U_MCU", 21],
    ["J_CAMERA", 12],
  ],
  CAM_SCL: [
    ["U_MCU", 22],
    ["J_CAMERA", 20],
  ],
  CAM_SDA: [
    ["U_MCU", 23],
    ["J_CAMERA", 22],
  ],
  CAM_PWDN: [
    ["U_MCU", 24],
    ["J_CAMERA", 17],
  ],
  CAM_RESET: [
    ["U_MCU", 27],
    ["J_CAMERA", 19],
  ],
  UART_TX: [
    ["U_MCU", 49],
    ["J_DEBUG", 3],
  ],
  UART_RX: [
    ["U_MCU", 50],
    ["J_DEBUG", 4],
  ],
  GPIO39: [
    ["U_MCU", 44],
    ["J_GPIO", 3],
  ],
  GPIO40: [
    ["U_MCU", 45],
    ["J_GPIO", 4],
  ],
  GPIO41: [
    ["U_MCU", 47],
    ["J_GPIO", 5],
  ],
  GPIO42: [
    ["U_MCU", 48],
    ["J_GPIO", 6],
  ],
  GPIO47: [
    ["U_MCU", 37],
    ["J_GPIO", 7],
  ],
  GPIO48: [
    ["U_MCU", 36],
    ["J_GPIO", 8],
  ],
  STATUS: [["U_MCU", 43]],
  LED_ANODE: [["D_STATUS", 1]],
  RF_CHIP: [
    ["U_MCU", 1],
    ["L_RF", 1],
    ["C_RF_MATCH1", 1],
  ],
  RF_ANTENNA: [
    ["L_RF", 2],
    ["C_RF_MATCH2", 1],
    ["J_RF", 2],
  ],
}

for (const [name, , net] of caps) {
  nets[net] = [...nets[net]!, [name, 1]]
  nets.GND = [...nets.GND!, [name, 2]]
}
for (const [name, , firstNet, secondNet] of resistors) {
  nets[firstNet] = [...nets[firstNet]!, [name, 1]]
  nets[secondNet] = [...nets[secondNet]!, [name, 2]]
}
nets.GND = [
  ...nets.GND!,
  ["C_XTAL_P", 2],
  ["C_XTAL_N", 2],
  ["C_RF_MATCH1", 2],
  ["C_RF_MATCH2", 2],
  ["D_STATUS", 2],
  ["J_RF", 1],
  ["J_RF", 3],
]

export const wifiCameraNets = nets

// Keep the short oscillator and RF branches on top copper. Numeric waypoints
// use the first component's local PCB frame; selectors resolve the actual pads.
const manualPcbPaths: Record<string, (string | { x: number; y: number })[][]> = {
  XTAL_P: [[".U_MCU > .pin54", { x: -1.8, y: 4.4 }, { x: -5, y: 4.4 }, ".L_XTAL > .pin1"]],
  XTAL_P_CRYSTAL: [
    [".L_XTAL > .pin2", { x: 0.51, y: -0.8 }, { x: 0.75, y: -1.04 }, ".Y_MAIN > .pin1"],
    [".L_XTAL > .pin2", { x: 1.02, y: 0.51 }, ".C_XTAL_P > .pin1"],
  ],
  XTAL_N: [
    [
      ".U_MCU > .pin53",
      { x: -1.4, y: 4.5 },
      { x: 0.6, y: 4.5 },
      { x: 0.6, y: 7.85 },
      ".Y_MAIN > .pin3",
    ],
    [".Y_MAIN > .pin3", { x: 1.49, y: 1.24 }, ".C_XTAL_N > .pin1"],
  ],
  RF_CHIP: [
    [".U_MCU > .pin1", { x: -4.6, y: 2.6 }, ".C_RF_MATCH1 > .pin1"],
    [".C_RF_MATCH1 > .pin1", { x: 0, y: 0.51 }, ".L_RF > .pin1"],
  ],
  RF_ANTENNA: [
    [".L_RF > .pin2", { x: 1.39, y: 0 }, ".C_RF_MATCH2 > .pin1"],
    [".C_RF_MATCH2 > .pin1", { x: 0, y: 0.51 }, ".J_RF > .pin2"],
  ],
  CC1: [
    [
      ".J_USB_C > .pin18",
      { x: -1.25, y: 3.2 },
      { x: -4, y: 5.5 },
      { x: -7, y: 5.5 },
      ".R_CC1 > .pin1",
    ],
  ],
}

export default function WifiCameraController() {
  return (
    <board
      isViaInPadAllowed
      width="85mm"
      height="65mm"
      minTraceWidth="0.1mm"
      nominalTraceWidth="0.15mm"
      schLayout={{ layoutMode: "relative" }}
    >
      <schematicsheet
        name="Bare ESP32-S3 camera controller qualification"
        sheetWidth="420mm"
        sheetHeight="297mm"
      >
        {Object.keys(nets).map((name) => (
          <Fragment key={name}>
            <net
              name={name}
              isGroundNet={name === "GND"}
              isPowerNet={["VBUS", "V3V3", "VDD_SPI", "CAM_AVDD", "CAM_DVDD"].includes(name)}
            />
          </Fragment>
        ))}

        <ESP32_S3R8
          name="U_MCU"
          pcbX={0}
          pcbY={0}
          schX={0}
          schY={0}
          schPinArrangement={{
            leftSide: {
              pins: [
                "pin1",
                "pin2",
                "pin3",
                "pin20",
                "pin46",
                "pin55",
                "pin56",
                "pin57",
                "pin4",
                "pin5",
                "pin53",
                "pin54",
                "pin25",
                "pin26",
                "pin51",
                "pin52",
                "pin6",
                "pin7",
                "pin8",
              ],
              direction: "top-to-bottom",
            },
            rightSide: {
              pins: [
                "pin9",
                "pin10",
                "pin11",
                "pin12",
                "pin13",
                "pin14",
                "pin15",
                "pin16",
                "pin17",
                "pin18",
                "pin19",
                "pin21",
                "pin22",
                "pin23",
                "pin24",
                "pin27",
                "pin43",
                "pin44",
                "pin45",
                "pin47",
                "pin48",
                "pin49",
                "pin50",
                "pin36",
                "pin37",
              ],
              direction: "top-to-bottom",
            },
            bottomSide: {
              pins: [
                "pin29",
                "pin32",
                "pin33",
                "pin35",
                "pin34",
                "pin31",
                "pin30",
                "pin28",
                "pin38",
                "pin39",
                "pin40",
                "pin41",
                "pin42",
              ],
              direction: "left-to-right",
            },
          }}
          noConnect={["pin6", "pin7", "pin8", "pin28", "pin38", "pin39", "pin40", "pin41", "pin42"]}
          pinAttributes={{
            pin2: { requiresPower: true },
            pin3: { requiresPower: true },
            pin20: { requiresPower: true },
            pin46: { requiresPower: true },
            pin55: { requiresPower: true },
            pin56: { requiresPower: true },
            pin57: { requiresGround: true },
            pin29: { providesPower: true },
          }}
        />
        <W25Q128JVSIQ
          pinAttributes={{ pin4: { requiresGround: true }, pin8: { requiresPower: true } }}
          name="U_FLASH"
          pcbX={13}
          pcbY={0}
          schX={7}
          schY={-4}
        />
        <AP2112K_3_3TRG1
          pinAttributes={{
            pin1: { requiresPower: true },
            pin2: { requiresGround: true },
            pin5: { providesPower: true },
            pin4: { doNotConnect: true },
          }}
          name="U_LDO"
          pcbX={-16}
          pcbY={-16}
          schX={-10.5}
          schY={6.5}
          noConnect={["pin4"]}
        />
        <USBLC6_2P6
          pinAttributes={{ pin2: { requiresGround: true }, pin5: { requiresPower: true } }}
          name="U_USB_ESD"
          pcbX={-25}
          pcbY={-21}
          schX={-13.5}
          schY={-0.5}
        />
        <TYPE_C_16PIN_2MD_073_
          name="J_USB_C"
          pcbX={-27}
          pcbY={-28}
          schX={-16}
          schY={2}
          noConnect={["pin17", "pin23"]}
        />
        <SM02B_PASS_TBT_LF__SN_ name="J_AUX_3V3" pcbX={27} pcbY={-24} schX={-5.5} schY={6.5} />
        <ME6211C28M5G_N
          pinAttributes={{
            pin1: { requiresPower: true },
            pin2: { requiresGround: true },
            pin5: { providesPower: true },
            pin4: { doNotConnect: true },
          }}
          name="U_CAM_ANALOG"
          pcbX={12}
          pcbY={22}
          schX={12.5}
          schY={7}
          noConnect={["pin4"]}
        />
        <TLV70013DDCR
          pinAttributes={{
            pin1: { requiresPower: true },
            pin2: { requiresGround: true },
            pin5: { providesPower: true },
            pin4: { doNotConnect: true },
          }}
          name="U_CAM_CORE"
          pcbX={19}
          pcbY={22}
          schX={16}
          schY={7}
          noConnect={["pin4"]}
        />
        <FH12_24S_0_5SH_55_
          pinAttributes={{
            pin10: { requiresGround: true },
            pin23: { requiresGround: true },
            pin14: { requiresPower: true },
            pin15: { requiresPower: true },
            pin21: { requiresPower: true },
          }}
          name="J_CAMERA"
          pcbX={0}
          pcbY={24}
          schX={9}
          schY={2.5}
          noConnect={["pin1", "pin2", "pin24"]}
          schPinArrangement={{
            leftSide: {
              pins: Array.from({ length: 26 }, (_, index) => `pin${index + 1}`),
              direction: "top-to-bottom",
            },
          }}
        />

        <pinheader
          name="J_DEBUG"
          pinCount={6}
          pinLabels={["V3V3", "GND", "UART_TX", "UART_RX", "CHIP_EN", "BOOT"]}
          schPinArrangement={{
            leftSide: {
              pins: ["pin1", "pin2", "pin3", "pin4", "pin5", "pin6"],
              direction: "top-to-bottom",
            },
          }}
          footprint="pinrow6_p2.54mm_id1mm_od1.8mm"
          pcbX={26}
          pcbY={-11}
          schX={7.5}
          schY={-8.5}
        />
        <pinheader
          name="J_GPIO"
          pinCount={8}
          pinLabels={["V3V3", "GND", "GPIO39", "GPIO40", "GPIO41", "GPIO42", "GPIO47", "GPIO48"]}
          schPinArrangement={{
            leftSide: {
              pins: ["pin1", "pin2", "pin3", "pin4", "pin5", "pin6", "pin7", "pin8"],
              direction: "top-to-bottom",
            },
          }}
          footprint="pinrow8_p2.54mm_id1mm_od1.8mm"
          pcbX={32}
          pcbY={8}
          pcbRotation={90}
          schX={13.5}
          schY={-1.5}
        />
        <pushbutton
          name="SW_BOOT"
          footprint="pushbutton_tllabel1_trlabel2_bllabel3_brlabel4"
          internallyConnectedPins={[
            ["pin1", "pin3"],
            ["pin2", "pin4"],
          ]}
          pcbX={-11}
          pcbY={-24}
          schX={-7}
          schY={-6.5}
        />
        <pushbutton
          name="SW_RESET"
          footprint="pushbutton_tllabel1_trlabel2_bllabel3_brlabel4"
          internallyConnectedPins={[
            ["pin1", "pin3"],
            ["pin2", "pin4"],
          ]}
          pcbX={-1}
          pcbY={-24}
          schX={-7}
          schY={-3}
        />
        <X322540MMB4SI
          loadCapacitance="10pF"
          name="Y_MAIN"
          pcbX={-2}
          pcbY={7}
          schX={-12.5}
          schY={-7.5}
        />
        <inductor
          name="L_XTAL"
          inductance="24nH"
          footprint="0402"
          pcbX={-5}
          pcbY={5.4}
          pcbRotation={90}
          schX={-11.5}
          schY={-6.5}
        />
        <U_FL_R_SMT_1_10_
          pinAttributes={{ pin1: { requiresGround: true }, pin3: { requiresGround: true } }}
          name="J_RF"
          pcbX={-18}
          pcbY={3}
          schX={-13}
          schY={-11.5}
        />

        {caps.map(([name, capacitance, , pcbX, pcbY, schX, schY]) => (
          <Fragment key={name}>
            <capacitor
              name={name}
              capacitance={capacitance}
              footprint={capacitance === "10uF" ? "0805" : "0603"}
              pcbX={pcbX}
              pcbY={pcbY}
              pcbRotation={90}
              schX={schX}
              schY={schY}
              schRotation={270}
            />
          </Fragment>
        ))}
        {resistors.map(([name, resistance, , , pcbX, pcbY, schX, schY]) => (
          <Fragment key={name}>
            <resistor
              name={name}
              resistance={resistance}
              footprint="0603"
              pcbX={pcbX}
              pcbY={pcbY}
              schX={schX}
              schY={schY}
            />
          </Fragment>
        ))}
        <capacitor
          name="C_XTAL_P"
          capacitance="14pF"
          footprint="0402"
          pcbX={-5}
          pcbY={7.5}
          schX={-14}
          schY={-9}
          schRotation={270}
        />
        <capacitor
          name="C_XTAL_N"
          capacitance="14pF"
          footprint="0402"
          pcbX={1.25}
          pcbY={9}
          schX={-11.5}
          schY={-9}
          schRotation={270}
        />
        <inductor
          name="L_RF"
          inductance="2nH"
          footprint="0402"
          pcbX={-6.8}
          pcbY={3}
          pcbRotation={180}
          schX={-9}
          schY={-11.5}
        />
        <capacitor
          name="C_RF_MATCH1"
          capacitance="1.5pF"
          footprint="0402"
          pcbX={-4.9}
          pcbY={3}
          pcbRotation={90}
          schX={-7}
          schY={-12.5}
          schRotation={270}
        />
        <capacitor
          name="C_RF_MATCH2"
          capacitance="1.5pF"
          footprint="0402"
          pcbX={-8.7}
          pcbY={3}
          pcbRotation={90}
          schX={-11}
          schY={-12.5}
          schRotation={270}
        />
        <led
          name="D_STATUS"
          color="green"
          footprint="0603"
          pcbX={27}
          pcbY={-18}
          schX={13.5}
          schY={-8}
        />

        {Object.entries(nets).map(([net, pins]) =>
          manualPcbPaths[net]
            ? manualPcbPaths[net].map((pcbPath, branch) => (
                <Fragment key={`${net}_${branch}`}>
                  <trace
                    name={`${net}_${branch}`}
                    path={[pcbPath[0] as string, pcbPath.at(-1) as string, `net.${net}`]}
                    pcbPath={pcbPath}
                    maxViaCount={net.startsWith("XTAL_") ? 0 : undefined}
                    maxLength={net.startsWith("XTAL_") ? "10mm" : undefined}
                    schDisplayLabel={net}
                  />
                </Fragment>
              ))
            : pins.map(([component, pin]) => (
                <Fragment key={`${net}_${component}_${pin}`}>
                  <trace
                    name={`${net}_${component}_${pin}`}
                    from={`.${component} > .pin${pin}`}
                    to={`net.${net}`}
                    schDisplayLabel={net}
                  />
                </Fragment>
              )),
        )}
      </schematicsheet>
    </board>
  )
}
