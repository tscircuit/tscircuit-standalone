export interface StandaloneDevState {
  entryPath: string
  sourceRevision: string
  status: "building" | "ready" | "error"
  generation: number
  fsMap?: Record<string, string>
  mainComponentPath?: string
  error?: string
}

export interface StandaloneDevSource {
  path: string
  source: string
  revision: string
}

export interface StandaloneDevImport {
  path: string
  source: string
}

export interface StandaloneDevAsset {
  content: string | Uint8Array
  contentType: string
}

export interface StandaloneDevOptions {
  projectDir?: string
  port?: number
  assets: Record<string, StandaloneDevAsset>
}
