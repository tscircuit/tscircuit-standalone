// Datasheet API record: 2a51fc64-5154-4513-ad7c-29429bdc973e
// https://pip-assets.raspberrypi.com/categories/814-rp2040/documents/RP-008371-DS-1-rp2040-datasheet.pdf
// https://pip-assets.raspberrypi.com/categories/814-rp2040/documents/RP-008279-DS-2-hardware-design-with-rp2040.pdf
import type { ChipProps } from "@tscircuit/props"

const pinLabels = {
  "pin1": [
    "IOVDD"
  ],
  "pin2": [
    "GPIO0",
    "SPI0_RX",
    "UART0_TX",
    "I2C0_SDA",
    "PWM0_A",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_OVCUR_DET"
  ],
  "pin3": [
    "GPIO1",
    "SPI0_CSn",
    "UART0_RX",
    "I2C0_SCL",
    "PWM0_B",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_VBUS_DET"
  ],
  "pin4": [
    "GPIO2",
    "SPI0_SCK",
    "UART0_CTS",
    "I2C1_SDA",
    "PWM1_A",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_VBUS_EN"
  ],
  "pin5": [
    "GPIO3",
    "SPI0_TX",
    "UART0_RTS",
    "I2C1_SCL",
    "PWM1_B",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_OVCUR_DET"
  ],
  "pin6": [
    "GPIO4",
    "SPI0_RX",
    "UART1_TX",
    "I2C0_SDA",
    "PWM2_A",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_VBUS_DET"
  ],
  "pin7": [
    "GPIO5",
    "SPI0_CSn",
    "UART1_RX",
    "I2C0_SCL",
    "PWM2_B",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_VBUS_EN"
  ],
  "pin8": [
    "GPIO6",
    "SPI0_SCK",
    "UART1_CTS",
    "I2C1_SDA",
    "PWM3_A",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_OVCUR_DET"
  ],
  "pin9": [
    "GPIO7",
    "SPI0_TX",
    "UART1_RTS",
    "I2C1_SCL",
    "PWM3_B",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_VBUS_DET"
  ],
  "pin10": [
    "IOVDD"
  ],
  "pin11": [
    "GPIO8",
    "SPI1_RX",
    "UART1_TX",
    "I2C0_SDA",
    "PWM4_A",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_VBUS_EN"
  ],
  "pin12": [
    "GPIO9",
    "SPI1_CSn",
    "UART1_RX",
    "I2C0_SCL",
    "PWM4_B",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_OVCUR_DET"
  ],
  "pin13": [
    "GPIO10",
    "SPI1_SCK",
    "UART1_CTS",
    "I2C1_SDA",
    "PWM5_A",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_VBUS_DET"
  ],
  "pin14": [
    "GPIO11",
    "SPI1_TX",
    "UART1_RTS",
    "I2C1_SCL",
    "PWM5_B",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_VBUS_EN"
  ],
  "pin15": [
    "GPIO12",
    "SPI1_RX",
    "UART0_TX",
    "I2C0_SDA",
    "PWM6_A",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_OVCUR_DET"
  ],
  "pin16": [
    "GPIO13",
    "SPI1_CSn",
    "UART0_RX",
    "I2C0_SCL",
    "PWM6_B",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_VBUS_DET"
  ],
  "pin17": [
    "GPIO14",
    "SPI1_SCK",
    "UART0_CTS",
    "I2C1_SDA",
    "PWM7_A",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_VBUS_EN"
  ],
  "pin18": [
    "GPIO15",
    "SPI1_TX",
    "UART0_RTS",
    "I2C1_SCL",
    "PWM7_B",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_OVCUR_DET"
  ],
  "pin19": [
    "TESTEN"
  ],
  "pin20": [
    "XIN"
  ],
  "pin21": [
    "XOUT"
  ],
  "pin22": [
    "IOVDD"
  ],
  "pin23": [
    "DVDD"
  ],
  "pin24": [
    "SWCLK"
  ],
  "pin25": [
    "SWD"
  ],
  "pin26": [
    "RUN"
  ],
  "pin27": [
    "GPIO16",
    "SPI0_RX",
    "UART0_TX",
    "I2C0_SDA",
    "PWM0_A",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_VBUS_DET"
  ],
  "pin28": [
    "GPIO17",
    "SPI0_CSn",
    "UART0_RX",
    "I2C0_SCL",
    "PWM0_B",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_VBUS_EN"
  ],
  "pin29": [
    "GPIO18",
    "SPI0_SCK",
    "UART0_CTS",
    "I2C1_SDA",
    "PWM1_A",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_OVCUR_DET"
  ],
  "pin30": [
    "GPIO19",
    "SPI0_TX",
    "UART0_RTS",
    "I2C1_SCL",
    "PWM1_B",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_VBUS_DET"
  ],
  "pin31": [
    "GPIO20",
    "SPI0_RX",
    "UART1_TX",
    "I2C0_SDA",
    "PWM2_A",
    "SIO",
    "PIO0",
    "PIO1",
    "CLOCK_GPIN0",
    "USB_VBUS_EN"
  ],
  "pin32": [
    "GPIO21",
    "SPI0_CSn",
    "UART1_RX",
    "I2C0_SCL",
    "PWM2_B",
    "SIO",
    "PIO0",
    "PIO1",
    "CLOCK_GPOUT0",
    "USB_OVCUR_DET"
  ],
  "pin33": [
    "IOVDD"
  ],
  "pin34": [
    "GPIO22",
    "SPI0_SCK",
    "UART1_CTS",
    "I2C1_SDA",
    "PWM3_A",
    "SIO",
    "PIO0",
    "PIO1",
    "CLOCK_GPIN1",
    "USB_VBUS_DET"
  ],
  "pin35": [
    "GPIO23",
    "SPI0_TX",
    "UART1_RTS",
    "I2C1_SCL",
    "PWM3_B",
    "SIO",
    "PIO0",
    "PIO1",
    "CLOCK_GPOUT1",
    "USB_VBUS_EN"
  ],
  "pin36": [
    "GPIO24",
    "SPI1_RX",
    "UART1_TX",
    "I2C0_SDA",
    "PWM4_A",
    "SIO",
    "PIO0",
    "PIO1",
    "CLOCK_GPOUT2",
    "USB_OVCUR_DET"
  ],
  "pin37": [
    "GPIO25",
    "SPI1_CSn",
    "UART1_RX",
    "I2C0_SCL",
    "PWM4_B",
    "SIO",
    "PIO0",
    "PIO1",
    "CLOCK_GPOUT3",
    "USB_VBUS_DET"
  ],
  "pin38": [
    "GPIO26",
    "SPI1_SCK",
    "UART1_CTS",
    "I2C1_SDA",
    "PWM5_A",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_VBUS_EN",
    "ADC0"
  ],
  "pin39": [
    "GPIO27",
    "SPI1_TX",
    "UART1_RTS",
    "I2C1_SCL",
    "PWM5_B",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_OVCUR_DET",
    "ADC1"
  ],
  "pin40": [
    "GPIO28",
    "SPI1_RX",
    "UART0_TX",
    "I2C0_SDA",
    "PWM6_A",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_VBUS_DET",
    "ADC2"
  ],
  "pin41": [
    "GPIO29",
    "SPI1_CSn",
    "UART0_RX",
    "I2C0_SCL",
    "PWM6_B",
    "SIO",
    "PIO0",
    "PIO1",
    "USB_VBUS_EN",
    "ADC3"
  ],
  "pin42": [
    "IOVDD"
  ],
  "pin43": [
    "ADC_AVDD"
  ],
  "pin44": [
    "VREG_VIN"
  ],
  "pin45": [
    "VREG_VOUT"
  ],
  "pin46": [
    "USB_DM"
  ],
  "pin47": [
    "USB_DP"
  ],
  "pin48": [
    "USB_VDD"
  ],
  "pin49": [
    "IOVDD"
  ],
  "pin50": [
    "DVDD"
  ],
  "pin51": [
    "QSPI_SD3"
  ],
  "pin52": [
    "QSPI_SCLK"
  ],
  "pin53": [
    "QSPI_SD0"
  ],
  "pin54": [
    "QSPI_SD2"
  ],
  "pin55": [
    "QSPI_SD1"
  ],
  "pin56": [
    "QSPI_CSn"
  ],
  "pin57": [
    "GND",
    "thermalpad"
  ]
} as const

export const RP2040 = (props: ChipProps<typeof pinLabels>) => (
  <chip
    pinLabels={pinLabels}
    pinAttributes={{
  "pin1": {
    "capabilities": [],
    "isInput": true,
    "mustBeConnected": true,
    "recommendedDecouplingCapacitorCapacitance": "100nF",
    "requiresPower": true,
    "shouldHaveDecouplingCapacitor": true
  },
  "pin10": {
    "capabilities": [],
    "isInput": true,
    "mustBeConnected": true,
    "recommendedDecouplingCapacitorCapacitance": "100nF",
    "requiresPower": true,
    "shouldHaveDecouplingCapacitor": true
  },
  "pin11": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_miso",
      "i2c_sda",
      "uart_tx"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin12": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_cs",
      "i2c_scl",
      "uart_rx"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin13": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_sck",
      "i2c_sda"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin14": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_mosi",
      "i2c_scl"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin15": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_miso",
      "i2c_sda",
      "uart_tx"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin16": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_cs",
      "i2c_scl",
      "uart_rx"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin17": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_sck",
      "i2c_sda"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin18": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_mosi",
      "i2c_scl"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin19": {
    "capabilities": [],
    "isInput": true,
    "mustBeConnected": true,
    "requiresGround": true,
    "requiresVoltage": 0
  },
  "pin2": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_miso",
      "i2c_sda",
      "uart_tx"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin20": {
    "capabilities": [],
    "isInput": true
  },
  "pin21": {
    "capabilities": [],
    "isOutput": true
  },
  "pin22": {
    "capabilities": [],
    "isInput": true,
    "mustBeConnected": true,
    "recommendedDecouplingCapacitorCapacitance": "100nF",
    "requiresPower": true,
    "shouldHaveDecouplingCapacitor": true
  },
  "pin23": {
    "capabilities": [],
    "isInput": true,
    "mustBeConnected": true,
    "recommendedDecouplingCapacitorCapacitance": "100nF",
    "requiresPower": true,
    "shouldHaveDecouplingCapacitor": true
  },
  "pin24": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "capabilities": [],
    "isInput": true
  },
  "pin25": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "capabilities": [],
    "isBidirectional": true,
    "isInput": true,
    "isOutput": true
  },
  "pin26": {
    "canUseInternalPullup": true,
    "capabilities": [],
    "isInput": true
  },
  "pin27": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_miso",
      "i2c_sda",
      "uart_tx"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin28": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_cs",
      "i2c_scl",
      "uart_rx"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin29": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_sck",
      "i2c_sda"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin3": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_cs",
      "i2c_scl",
      "uart_rx"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin30": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_mosi",
      "i2c_scl"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin31": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_miso",
      "i2c_sda",
      "uart_tx"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin32": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_cs",
      "i2c_scl",
      "uart_rx"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin33": {
    "capabilities": [],
    "isInput": true,
    "mustBeConnected": true,
    "recommendedDecouplingCapacitorCapacitance": "100nF",
    "requiresPower": true,
    "shouldHaveDecouplingCapacitor": true
  },
  "pin34": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_sck",
      "i2c_sda"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin35": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_mosi",
      "i2c_scl"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin36": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_miso",
      "i2c_sda",
      "uart_tx"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin37": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_cs",
      "i2c_scl",
      "uart_rx"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin38": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_sck",
      "i2c_sda"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin39": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_mosi",
      "i2c_scl"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin4": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_sck",
      "i2c_sda"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin40": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_miso",
      "i2c_sda",
      "uart_tx"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin41": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_cs",
      "i2c_scl",
      "uart_rx"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin42": {
    "capabilities": [],
    "isInput": true,
    "mustBeConnected": true,
    "recommendedDecouplingCapacitorCapacitance": "100nF",
    "requiresPower": true,
    "shouldHaveDecouplingCapacitor": true
  },
  "pin43": {
    "capabilities": [],
    "isInput": true,
    "mustBeConnected": true,
    "recommendedDecouplingCapacitorCapacitance": "100nF",
    "requiresPower": true,
    "shouldHaveDecouplingCapacitor": true
  },
  "pin44": {
    "capabilities": [],
    "isInput": true,
    "mustBeConnected": true,
    "recommendedDecouplingCapacitorCapacitance": "1uF",
    "requiresPower": true,
    "shouldHaveDecouplingCapacitor": true
  },
  "pin45": {
    "canUseTriState": true,
    "capabilities": [],
    "isOutput": true,
    "providesPower": true,
    "recommendedDecouplingCapacitorCapacitance": "1uF",
    "shouldHaveDecouplingCapacitor": true
  },
  "pin46": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "capabilities": [],
    "isBidirectional": true,
    "isInput": true,
    "isOutput": true
  },
  "pin47": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "capabilities": [],
    "isBidirectional": true,
    "isInput": true,
    "isOutput": true
  },
  "pin48": {
    "capabilities": [],
    "isInput": true,
    "mustBeConnected": true,
    "recommendedDecouplingCapacitorCapacitance": "100nF",
    "requiresPower": true,
    "shouldHaveDecouplingCapacitor": true
  },
  "pin49": {
    "capabilities": [],
    "isInput": true,
    "mustBeConnected": true,
    "recommendedDecouplingCapacitorCapacitance": "100nF",
    "requiresPower": true,
    "shouldHaveDecouplingCapacitor": true
  },
  "pin5": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_mosi",
      "i2c_scl"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin50": {
    "capabilities": [],
    "isInput": true,
    "mustBeConnected": true,
    "recommendedDecouplingCapacitorCapacitance": "100nF",
    "requiresPower": true,
    "shouldHaveDecouplingCapacitor": true
  },
  "pin51": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin52": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_sck"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin53": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_mosi"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin54": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin55": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_miso"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin56": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_cs"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin57": {
    "capabilities": [],
    "mustBeConnected": true,
    "requiresGround": true,
    "requiresVoltage": 0
  },
  "pin6": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_miso",
      "i2c_sda",
      "uart_tx"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin7": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_cs",
      "i2c_scl",
      "uart_rx"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin8": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_sck",
      "i2c_sda"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  },
  "pin9": {
    "canUseInternalPulldown": true,
    "canUseInternalPullup": true,
    "canUsePushPull": true,
    "capabilities": [
      "spi_mosi",
      "i2c_scl"
    ],
    "isBidirectional": true,
    "isGpio": true,
    "isInput": true,
    "isOutput": true
  }
}}
    supplierPartNumbers={{ jlcpcb: ["C2040"] }}
    manufacturerPartNumber={"RP2040"}
    footprint={"qfn56_thermalpad3.1mmx3.1mm_p0.4mm_h7.9mm_pw0.2mm_pl0.85mm"}
    {...props}
  />
)

export default RP2040
