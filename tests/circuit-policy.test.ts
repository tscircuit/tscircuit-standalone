import { expect, test } from "bun:test"
import type { AnyCircuitElement } from "circuit-json"
import { validateEmbeddedAssets } from "../lib/circuit-policy"

const dataJson = (json: unknown) =>
  `data:model/gltf+json,${encodeURIComponent(JSON.stringify(json))}`
const dataSvg = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`
const dataBinary = (bytes: Uint8Array, mimetype = "model/gltf-binary") =>
  `data:${mimetype};base64,${Buffer.from(bytes).toString("base64")}`
const cad = (values: Record<string, unknown>): AnyCircuitElement[] => [
  {
    type: "cad_component",
    cad_component_id: "cad_component_0",
    source_component_id: "source_component_0",
    position: { x: 0, y: 0, z: 0 },
    model_object_fit: "contain_within_bounds",
    anchor_alignment: "center",
    ...values,
  } as AnyCircuitElement,
]
const graphic = (values: Record<string, unknown>): AnyCircuitElement[] => [
  {
    type: "schematic_graphic",
    schematic_graphic_id: "graphic_0",
    ...values,
  } as AnyCircuitElement,
]
const modelAsset = (url: string, mimetype: string, path = "model.bin") =>
  cad({
    model_asset: { url, mimetype, project_relative_path: path },
  })
const glb = (json: unknown, binary?: Uint8Array) => {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const jsonLength = Math.ceil(jsonBytes.length / 4) * 4
  const binaryLength = binary ? Math.ceil(binary.length / 4) * 4 : 0
  const bytes = new Uint8Array(
    20 + jsonLength + (binary ? 8 + binaryLength : 0),
  )
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, bytes.length, true)
  view.setUint32(12, jsonLength, true)
  view.setUint32(16, 0x4e4f534a, true)
  bytes.fill(32, 20, 20 + jsonLength)
  bytes.set(jsonBytes, 20)
  if (binary) {
    view.setUint32(20 + jsonLength, binaryLength, true)
    view.setUint32(24 + jsonLength, 0x004e4942, true)
    bytes.set(binary, 28 + jsonLength)
  }
  return bytes
}

test("self-contained GLTF and GLB resources pass without fetching", () => {
  const json = {
    asset: { version: "2.0" },
    buffers: [
      { uri: "data:application/octet-stream;base64,AAAA", byteLength: 3 },
    ],
    images: [{ uri: "data:image/png;base64,iVBORw0KGgo=" }],
    extensionsUsed: ["KHR_materials_unlit"],
  }
  expect(() =>
    validateEmbeddedAssets(cad({ model_gltf_url: dataJson(json) })),
  ).not.toThrow()
  expect(() =>
    validateEmbeddedAssets(
      cad({
        model_glb_url: dataBinary(
          glb(
            { asset: { version: "2.0" }, buffers: [{ byteLength: 4 }] },
            new Uint8Array(4),
          ),
        ),
      }),
    ),
  ).not.toThrow()
  expect(() =>
    validateEmbeddedAssets(modelAsset(dataJson(json), "model/gltf+json")),
  ).not.toThrow()
  expect(() =>
    validateEmbeddedAssets(
      modelAsset(
        dataBinary(glb({ asset: { version: "2.0" } })),
        "application/octet-stream",
        "component.glb",
      ),
    ),
  ).not.toThrow()
})

test("GLTF and GLB reject external buffer and texture references before handoff", () => {
  for (const uri of [
    "https://example.invalid/texture.png",
    "//example.invalid/buffer.bin",
    "texture.png",
    "/assets/texture.png",
    "blob:local-resource",
  ]) {
    for (const resource of [
      { buffers: [{ uri, byteLength: 4 }] },
      { images: [{ uri }] },
    ]) {
      const json = { asset: { version: "2.0" }, ...resource }
      expect(() =>
        validateEmbeddedAssets(cad({ model_gltf_url: dataJson(json) })),
      ).toThrow("not embedded")
      expect(() =>
        validateEmbeddedAssets(cad({ model_glb_url: dataBinary(glb(json)) })),
      ).toThrow("not embedded")
      expect(() =>
        validateEmbeddedAssets(
          modelAsset(
            dataJson(json),
            "application/octet-stream",
            "component.gltf",
          ),
        ),
      ).toThrow("not embedded")
    }
  }
})

test("GLTF rejects unavailable compression and image decoder dependencies", () => {
  for (const extension of [
    "KHR_draco_mesh_compression",
    "KHR_texture_basisu",
    "EXT_meshopt_compression",
  ]) {
    for (const resource of [
      { extensionsUsed: [extension] },
      { meshes: [{ extensions: { [extension]: {} } }] },
    ]) {
      expect(() =>
        validateEmbeddedAssets(
          cad({
            model_gltf_url: dataJson({
              asset: { version: "2.0" },
              ...resource,
            }),
          }),
        ),
      ).toThrow("unbundled GLTF compression decoder")
    }
  }
  expect(() =>
    validateEmbeddedAssets(
      cad({
        model_gltf_url: dataJson({
          asset: { version: "2.0" },
          images: [{ uri: "data:image/ktx2;base64,AAAA" }],
        }),
      }),
    ),
  ).toThrow("unbundled GLTF image decoder")
})

test("malformed or unresolved inline models fail locally", () => {
  const malformed = [
    "data:model/gltf+json,%GG",
    "data:model/gltf+json;base64,!!!",
    "data:model/gltf+json,not-json",
    dataJson({ asset: { version: "1.0" } }),
    dataJson({ asset: { version: "2.0" }, buffers: [{ byteLength: 4 }] }),
    dataJson({
      asset: { version: "2.0" },
      buffers: [
        { uri: "data:application/octet-stream;base64,AAAA", byteLength: 100 },
      ],
    }),
  ]
  for (const url of malformed)
    expect(() => validateEmbeddedAssets(cad({ model_gltf_url: url }))).toThrow()
  const valid = glb({ asset: { version: "2.0" } })
  for (const corrupt of [
    valid.subarray(0, 10),
    valid.subarray(0, valid.length - 1),
  ]) {
    expect(() =>
      validateEmbeddedAssets(cad({ model_glb_url: dataBinary(corrupt) })),
    ).toThrow("invalid GLB header")
  }
  const badChunk = valid.slice()
  new DataView(badChunk.buffer).setUint32(12, 0xffffffff, true)
  expect(() =>
    validateEmbeddedAssets(cad({ model_glb_url: dataBinary(badChunk) })),
  ).toThrow("invalid GLB chunk length")
})

test("compound asset parsing has decoded-size and structure limits", () => {
  expect(() =>
    validateEmbeddedAssets(
      cad({
        model_gltf_url: `data:model/gltf+json;base64,${"AAAA".repeat(2_796_204)}`,
      }),
    ),
  ).toThrow("8 MiB")
  let nested: unknown = null
  for (let index = 0; index < 70; index++) nested = { nested }
  expect(() =>
    validateEmbeddedAssets(
      cad({ model_gltf_url: dataJson({ asset: { version: "2.0" }, nested }) }),
    ),
  ).toThrow("GLTF structure limit")
})

test("SVG accepts static local references and embedded raster images", () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="shape" d="M0 0L1 1" /></defs><use href="#shape"/><rect style="fill:url(#gradient)"/><image href="data:image/png;base64,iVBORw0KGgo=" /></svg>'
  expect(() =>
    validateEmbeddedAssets(graphic({ svg_content: svg })),
  ).not.toThrow()
  expect(() =>
    validateEmbeddedAssets(
      graphic({
        asset: {
          url: dataSvg(svg),
          mimetype: "image/svg+xml",
          project_relative_path: "drawing.svg",
        },
      }),
    ),
  ).not.toThrow()
  expect(() =>
    validateEmbeddedAssets(
      cad({
        model_gltf_url: dataJson({
          asset: { version: "2.0" },
          images: [{ uri: dataSvg(svg) }],
        }),
      }),
    ),
  ).not.toThrow()
})

test("SVG rejects external references hidden in XML entities or escaped CSS", () => {
  const sources = [
    '<svg><image href="https://example.invalid/image.png"/></svg>',
    '<svg><use xlink:href="&#x68;ttps://example.invalid/image.svg#part"/></svg>',
    '<svg><image href="image.png"/></svg>',
    "<svg><style>.x{fill:url(https://example.invalid/paint.svg)}</style></svg>",
    String.raw`<svg><style>.x{fill:u\72l(\68 ttps://example.invalid/paint.svg)}</style></svg>`,
    '<svg><style>@import "https://example.invalid/styles.css";</style></svg>',
    '<svg><style>.x{background:image-set("https://example.invalid/image.png" 1x)}</style></svg>',
    '<svg><image href="#safe"><set attributeName="href" to="https://example.invalid/image.png"/></image></svg>',
    '<!DOCTYPE svg [<!ENTITY resource SYSTEM "https://example.invalid/file">]><svg/>',
    '<svg></svg><object data="https://example.invalid/model.html"></object>',
  ]
  for (const svg of sources) {
    expect(() =>
      validateEmbeddedAssets(graphic({ svg_content: svg })),
    ).toThrow()
    expect(() =>
      validateEmbeddedAssets(
        graphic({
          asset: {
            url: dataSvg(svg),
            mimetype: "image/svg+xml",
            project_relative_path: "drawing.svg",
          },
        }),
      ),
    ).toThrow()
  }
})

test("nested SVG references are inspected in data images and GLB buffer views", () => {
  const unsafe = '<svg><image href="https://example.invalid/image.png"/></svg>'
  const outer = `<svg><image href="${dataSvg(unsafe)}"/></svg>`
  expect(() => validateEmbeddedAssets(graphic({ svg_content: outer }))).toThrow(
    "not embedded",
  )
  const bytes = new TextEncoder().encode(unsafe)
  const json = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: bytes.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bytes.length }],
    images: [{ bufferView: 0, mimeType: "image/svg+xml" }],
  }
  expect(() =>
    validateEmbeddedAssets(
      cad({ model_glb_url: dataBinary(glb(json, bytes)) }),
    ),
  ).toThrow("not embedded")
})

test("inline WRL and 3MF fail explicitly while ordinary binary models remain allowed", () => {
  for (const format of ["wrl", "3mf"]) {
    expect(() =>
      validateEmbeddedAssets(
        cad({
          [`model_${format}_url`]: "data:application/octet-stream;base64,AAAA",
        }),
      ),
    ).toThrow("nested resources are unsupported")
    expect(() =>
      validateEmbeddedAssets(
        modelAsset(
          "data:application/octet-stream;base64,AAAA",
          "application/octet-stream",
          `component.${format}`,
        ),
      ),
    ).toThrow("nested resources are unsupported")
  }
  for (const format of ["stl", "step", "obj"]) {
    expect(() =>
      validateEmbeddedAssets(
        cad({
          [`model_${format}_url`]: "data:application/octet-stream;base64,AAAA",
        }),
      ),
    ).not.toThrow()
  }
})
