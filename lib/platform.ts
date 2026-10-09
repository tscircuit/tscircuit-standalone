import type { PartsEngine, PlatformConfig } from "@tscircuit/props"
import {
  bundledCatalog,
  generateBundledComponentTsx,
  getBundledFootprintCircuitJson,
  getBundledPart,
  type BundledCatalog,
} from "./catalog"

export class OfflineRequestError extends Error {
  readonly code = "OFFLINE_REQUEST_NOT_BUNDLED"

  constructor(method: string, url: string) {
    super(
      `Request is not bundled in tscircuit standalone: ${method} ${url}. No network request was attempted.`,
    )
    this.name = "OfflineRequestError"
  }
}

/** Resolve explicit embedded resources; never delegate to the native fetch. */
export const createStandaloneFetch = (
  catalog: BundledCatalog = bundledCatalog,
): typeof fetch => {
  const standaloneFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = input instanceof Request ? input : undefined
    const rawUrl = request?.url ?? String(input)
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase()
    const signal = init?.signal ?? request?.signal
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Request aborted", "AbortError")
    }
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      throw new OfflineRequestError(method, rawUrl)
    }
    if (
      (method !== "GET" && method !== "HEAD") ||
      url.protocol !== "standalone:" ||
      url.hostname !== "parts" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new OfflineRequestError(method, rawUrl)
    }
    const match = url.pathname.match(
      /^\/(C[1-9]\d*)\/(component\.tsx|footprint\.json|metadata\.json)$/,
    )
    if (!match) throw new OfflineRequestError(method, rawUrl)
    const part = getBundledPart(match[1]!, catalog)
    const resource = match[2]
    const body =
      resource === "component.tsx"
        ? generateBundledComponentTsx(part)
        : JSON.stringify(
            resource === "footprint.json"
              ? getBundledFootprintCircuitJson(part)
              : part,
          )
    return new Response(method === "HEAD" ? null : body, {
      status: 200,
      headers: {
        "content-type":
          resource === "component.tsx"
            ? "text/plain; charset=utf-8"
            : "application/json; charset=utf-8",
      },
    })
  }
  // Bun exposes a preconnect helper on fetch. It must also fail closed if the
  // caller installs this function as the global fetch in a dedicated worker.
  return Object.assign(standaloneFetch, {
    preconnect: (url: string | URL): never => {
      throw new OfflineRequestError("PRECONNECT", String(url))
    },
  }) as typeof fetch
}

const createStandalonePartsEngine = (catalog: BundledCatalog): PartsEngine => ({
  findPart: ({ sourceComponent }) => {
    if (sourceComponent.type !== "source_component") return {}
    const supplierNumbers = sourceComponent.supplier_part_numbers?.jlcpcb
    if (supplierNumbers?.length) {
      return {
        jlcpcb: supplierNumbers.map(
          (supplierPartNumber) =>
            getBundledPart(supplierPartNumber, catalog).supplierPartNumber,
        ),
      }
    }
    const manufacturerPartNumber = sourceComponent.manufacturer_part_number
    if (!manufacturerPartNumber) return {}
    const matchingParts = catalog.parts.filter(
      (part) => part.manufacturerPartNumber === manufacturerPartNumber,
    )
    if (matchingParts.length === 0) {
      throw new Error(
        `Manufacturer part ${manufacturerPartNumber} is not bundled in tscircuit standalone. No network lookup was attempted.`,
      )
    }
    return {
      jlcpcb: matchingParts.map((part) => part.supplierPartNumber),
    }
  },
  fetchPartCircuitJson: ({ supplierPartNumber, manufacturerPartNumber }) => {
    if (supplierPartNumber) {
      return getBundledFootprintCircuitJson(
        getBundledPart(supplierPartNumber, catalog),
      )
    }
    const part = catalog.parts.find(
      (candidate) =>
        candidate.manufacturerPartNumber === manufacturerPartNumber,
    )
    if (!part) {
      throw new Error(
        `Manufacturer part ${manufacturerPartNumber ?? "(unspecified)"} is not bundled in tscircuit standalone. No network lookup was attempted.`,
      )
    }
    return getBundledFootprintCircuitJson(part)
  },
})

/**
 * Platform hooks for bundled parts and local rendering. Upstream paths that
 * bypass platformFetch still need worker/process isolation before full release.
 */
export const createStandalonePlatformConfig = (
  options: { catalog?: BundledCatalog } = {},
): PlatformConfig => {
  const catalog = options.catalog ?? bundledCatalog
  return {
    platformFetch: createStandaloneFetch(catalog),
    partsEngine: createStandalonePartsEngine(catalog),
    footprintLibraryMap: {
      jlcpcb: async (supplierPartNumber) => ({
        footprintCircuitJson: getBundledFootprintCircuitJson(
          getBundledPart(supplierPartNumber, catalog),
        ),
      }),
    },
    checkAvailability: false,
    useCloudAutorouter: false,
    allowLegacyAutorouters: false,
    analogSimulationDisabled: true,
    enablePartOrientationAnalysis: false,
    registryApiUrl: "standalone://registry",
    cloudAutorouterUrl: "standalone://disabled",
    projectBaseUrl: "standalone://project/",
  }
}
