import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
	copySearchCatalogs,
	searchProviders,
} from "../scripts/build-search-catalogs";
import { refreshSearchCatalogs } from "../scripts/refresh-search-catalogs";

const component = {
	lcsc: 2040,
	mfr: "RP2040",
	package: "QFN-56",
	description: "Microcontroller",
	stock: null,
	price: 1,
	raw: "omit this",
};
const capture = (async (input: Parameters<typeof fetch>[0]) => {
	const url = new URL(String(input));
	if (url.pathname.endsWith("kicad_files.json"))
		return Response.json(["Package.pretty/QFN-56.kicad_mod"]);
	if (url.pathname.endsWith("packages/search"))
		return Response.json({
			packages: [
				{ name: "test/RP2040", latest_version: "1.0.0", private_field: "omit" },
			],
		});
	return Response.json({ components: [component, component] });
}) as unknown as typeof fetch;

test("captures, deduplicates and embeds all providers using a versioned compressed format", async () => {
	const root = await mkdtemp(join(tmpdir(), "catalogs-"));
	try {
		const source = join(root, "captures");
		const results = await refreshSearchCatalogs({
			outputDirectory: source,
			fetch: capture,
			queries: ["RP2040"],
			jlcQueries: ["C2040"],
			generatedAt: "2026-11-06T00:00:00.000Z",
		});
		expect(results).toHaveLength(6);
		expect(results.every((result) => result.count === 1)).toBe(true);
		await copySearchCatalogs(join(root, "baked"), source);
		for (const provider of Object.keys(searchProviders)) {
			const bytes = await readFile(
				join(root, "baked", provider, "search-catalog.json.gz"),
			);
			const catalog = JSON.parse(gunzipSync(bytes).toString());
			expect(catalog.coverage).toBe("subset");
			expect(catalog.schema_version).toBe(1);
			expect(JSON.stringify(catalog)).not.toContain("omit");
			if (catalog.components) expect(catalog.components[0].stock).toBeNull();
		}
		await writeFile(join(source, "ti.json.gz"), "corrupt");
		await expect(copySearchCatalogs(join(root, "bad"), source)).rejects.toThrow(
			"checksum",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a failed refresh preserves the previous catalog", async () => {
	const root = await mkdtemp(join(tmpdir(), "catalogs-"));
	try {
		await writeFile(join(root, "manifest.json"), "previous");
		await expect(
			refreshSearchCatalogs({
				outputDirectory: root,
				fetch: (async () =>
					new Response("unavailable", { status: 503 })) as unknown as typeof fetch,
				queries: ["RP2040"],
			}),
		).rejects.toThrow("HTTP 503");
		expect(await readFile(join(root, "manifest.json"), "utf8")).toBe(
			"previous",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("checked-in captures cover all providers and both customer-reported part families", async () => {
	const root = await mkdtemp(join(tmpdir(), "catalogs-"));
	try {
		await copySearchCatalogs(root);
		for (const provider of ["ti", "digikey", "mouser"]) {
			const catalog = JSON.parse(
				gunzipSync(
					await readFile(join(root, provider, "search-catalog.json.gz")),
				).toString(),
			);
			for (const part of ["TPS63001", "MSPM0G3507"])
				expect(
					catalog.components.some((row: { mfr: string }) =>
						row.mfr.startsWith(part),
					),
				).toBe(true);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
