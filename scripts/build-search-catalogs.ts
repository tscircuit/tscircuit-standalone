import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

export const searchProviders = {
	jlcsearch: "jlcpcb",
	digikey: "digikey",
	mouser: "mouser",
	ti: "ti",
	kicad: "kicad",
	tscircuit: "tscircuit",
} as const;

/** Verify committed captures and copy them into the existing embedded asset tree. */
export async function copySearchCatalogs(
	outputDirectory: string,
	sourceDirectory = resolve(import.meta.dir, "../data/search-catalogs"),
) {
	const manifest = JSON.parse(
		await readFile(join(sourceDirectory, "manifest.json"), "utf8"),
	);
	if (manifest.schema_version !== 1)
		throw new Error("Unsupported search manifest");
	for (const [provider, source] of Object.entries(searchProviders)) {
		const entry = manifest.catalogs?.[provider];
		const filename = `${provider}.json.gz`;
		const bytes = await readFile(join(sourceDirectory, filename));
		if (
			!entry ||
			entry.sha256 !== createHash("sha256").update(bytes).digest("hex")
		)
			throw new Error(`Search catalog checksum mismatch: ${provider}`);
		const catalog = JSON.parse(
			gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }).toString("utf8"),
		);
		const rows =
			source === "kicad"
				? catalog.files
				: source === "tscircuit"
					? catalog.packages
					: catalog.components;
		if (
			catalog.schema_version !== 1 ||
			catalog.source !== source ||
			catalog.coverage !== "subset" ||
			!Number.isFinite(Date.parse(catalog.generated_at)) ||
			!Array.isArray(rows) ||
			!rows.length ||
			rows.length !== entry.count
		)
			throw new Error(`Invalid search catalog: ${provider}`);
		const destination = join(outputDirectory, provider);
		await mkdir(destination, { recursive: true });
		await writeFile(join(destination, "search-catalog.json.gz"), bytes);
	}
}
