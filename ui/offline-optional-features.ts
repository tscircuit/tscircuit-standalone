export const FileMenuLeftHeader = () => null

export const createCircuitWebWorker = (): never => {
  throw new Error("Standalone RunFrame requires host-rendered Circuit JSON; browser evaluation is unavailable")
}

export const internalDynamicImport = async (packageName: string): Promise<never> => {
  throw new Error(`Optional package ${packageName} is unavailable in tscircuit standalone`)
}

export const convertCircuitJsonToAltiumZip = async (): Promise<never> => {
  throw new Error("Altium export is unavailable in tscircuit standalone")
}

export class Resvg {
  constructor() {
    throw new Error("PNG export is unavailable in tscircuit standalone")
  }
}
export default async () => {
  throw new Error("Optional export is unavailable in tscircuit standalone")
}
