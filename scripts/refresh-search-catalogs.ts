import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { searchProviders } from "./build-search-catalogs";

export const commonQueries = [
	"NE555",
	"LM358",
	"RP2040",
	"ESP32",
	"STM32",
	"ATMEGA328",
	"AMS1117",
	"CH340",
	"TPS63001",
	"MSPM0G3507",
];
// Exact LCSC IDs avoid expensive full-table scans when capturing common passives.
const jlcQueries = [
	"C2040",
	"C14663",
	"C25804",
	"C17414",
	"C25744",
	"C2286",
	"C2290",
	"C1525",
	"C19702",
	"C6186",
	"C81598",
	"C165948",
	"C52923",
	"C1815",
	"C46749",
	"C12367",
	"C34743",
	"C2128",
	"C6188",
	"C1817",
];
const fields = [
	"lcsc",
	"mfr",
	"package",
	"description",
	"stock",
	"price",
	"supplier_part_number",
	"digikey_product_number",
	"mouser_product_number",
	"ti_product_number",
	"manufacturer",
	"product_url",
	"datasheet_url",
	"is_basic",
	"is_preferred",
	"category",
	"subcategory",
];

function compactComponent(row: Record<string, unknown>, provider: string) {
	if (
		typeof row.mfr !== "string" ||
		!row.mfr.trim() ||
		typeof row.package !== "string" ||
		typeof row.description !== "string" ||
		!(
			row.stock === null ||
			(typeof row.stock === "number" &&
				Number.isFinite(row.stock) &&
				row.stock >= 0)
		) ||
		!(
			row.price === null ||
			(typeof row.price === "number" &&
				Number.isFinite(row.price) &&
				row.price >= 0)
		) ||
		(provider === "jlcsearch" &&
			!(
				typeof row.lcsc === "number" &&
				Number.isSafeInteger(row.lcsc) &&
				row.lcsc > 0
			))
	)
		throw new Error(`Invalid ${provider} component`);
	for (const field of fields) {
		const value = row[field];
		if (
			value === undefined ||
			value === null ||
			["lcsc", "stock", "price"].includes(field)
		)
			continue;
		const expected = ["is_basic", "is_preferred"].includes(field)
			? "boolean"
			: "string";
		if (typeof value !== expected)
			throw new Error(`Invalid ${provider} field: ${field}`);
	}
	if (
		row.lcsc !== undefined &&
		row.lcsc !== null &&
		!(
			typeof row.lcsc === "number" &&
			Number.isSafeInteger(row.lcsc) &&
			row.lcsc > 0
		)
	)
		throw new Error(`Invalid ${provider} LCSC identity`);
	return Object.fromEntries(
		fields
			.filter(
				(key) =>
					row[key] !== undefined &&
					(row[key] !== null || ["lcsc", "stock", "price"].includes(key)),
			)
			.map((key) => [key, row[key]]),
	);
}

export async function refreshSearchCatalogs(
	options: {
		outputDirectory?: string;
		fetch?: typeof globalThis.fetch;
		generatedAt?: string;
		queries?: string[];
		jlcQueries?: string[];
	} = {},
) {
	const output = resolve(options.outputDirectory ?? "data/search-catalogs");
	const generatedAt = options.generatedAt ?? new Date().toISOString();
	if (!Number.isFinite(Date.parse(generatedAt)))
		throw new Error("Invalid capture timestamp");
	const request = async (url: URL | string, init?: RequestInit) => {
		const response = await (options.fetch ?? fetch)(url, {
			...init,
			headers: { accept: "application/json", ...init?.headers },
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok)
			throw new Error(`Search capture ${url}: HTTP ${response.status}`);
		return response.json();
	};
	// Fetch and validate everything before publishing any new catalog files.
	const captures: Array<{
		provider: string;
		bytes: Buffer;
		count: number;
		urls: string[];
	}> = [];
	for (const [provider, source] of Object.entries(searchProviders)) {
		const urls: string[] = [];
		const rows = new Map<string, unknown>();
		let key = "components";
		if (source === "kicad") {
			key = "files";
			const url = "https://kicad-mod-cache.tscircuit.com/kicad_files.json";
			urls.push(url);
			const files = await request(url);
			if (
				!Array.isArray(files) ||
				files.some(
					(file) => typeof file !== "string" || !file.endsWith(".kicad_mod"),
				)
			)
				throw new Error("Invalid KiCad inventory");
			for (const file of files) rows.set(file, file);
		} else {
			for (const query of provider === "jlcsearch"
				? (options.jlcQueries ?? jlcQueries)
				: (options.queries ?? commonQueries)) {
				const url = new URL(
					source === "tscircuit"
						? "https://api.tscircuit.com/packages/search"
						: `https://${provider === "jlcsearch" ? "jlcsearch" : provider === "ti" ? "tisearch" : `${provider}search`}.tscircuit.com/api/search`,
				);
				if (source !== "tscircuit") {
					url.searchParams.set("limit", "10");
					url.searchParams.set("q", query);
				}
				urls.push(
					source === "tscircuit" ? `${url} (query: ${query})` : url.toString(),
				);
				const body = await request(
					url,
					source === "tscircuit"
						? {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ query }),
							}
						: undefined,
				);
				key = source === "tscircuit" ? "packages" : "components";
				if (!Array.isArray(body?.[key]))
					throw new Error(`Invalid ${provider} search response`);
				for (const row of body[key]) {
					if (source === "tscircuit") {
						if (typeof row.name !== "string" || !row.name.trim())
							throw new Error("Invalid registry identity");
						const version = row.version ?? row.latest_version ?? "";
						if (typeof version !== "string")
							throw new Error("Invalid registry version");
						rows.set(row.name, {
							name: row.name,
							version,
							...(typeof row.description === "string"
								? { description: row.description }
								: {}),
							...(typeof row.star_count === "number"
								? { star_count: row.star_count }
								: {}),
						});
					} else {
						const compact = compactComponent(row, provider);
						const identity =
							provider === "jlcsearch"
								? row.lcsc
								: (row.supplier_part_number ??
									row[`${source}_product_number`] ??
									row.mfr);
						rows.set(String(identity), compact);
					}
				}
			}
		}
		if (!rows.size)
			throw new Error(`Refusing to publish empty ${provider} catalog`);
		const entries = [...rows.entries()]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([, row]) => row);
		const bytes = gzipSync(
			JSON.stringify({
				schema_version: 1,
				source,
				coverage: "subset",
				generated_at: generatedAt,
				[key]: entries,
			}),
			{ level: 9 },
		);
		captures.push({ provider, bytes, count: rows.size, urls });
	}
	await mkdir(dirname(output), { recursive: true });
	const staging = await mkdtemp(join(dirname(output), ".search-catalogs-"));
	const backup = `${output}.${crypto.randomUUID()}.backup`;
	let movedPrevious = false;
	try {
		const catalogs: Record<string, unknown> = {};
		for (const { provider, bytes, count, urls } of captures) {
			await writeFile(join(staging, `${provider}.json.gz`), bytes);
			catalogs[provider] = {
				count,
				gzip_bytes: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				urls,
			};
		}
		await writeFile(
			join(staging, "manifest.json"),
			`${JSON.stringify({ schema_version: 1, generated_at: generatedAt, catalogs }, null, 2)}\n`,
		);
		try {
			await rename(output, backup);
			movedPrevious = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		try {
			await rename(staging, output);
		} catch (error) {
			if (movedPrevious) await rename(backup, output);
			throw error;
		}
		if (movedPrevious) await rm(backup, { recursive: true, force: true });
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
	return captures.map(({ provider, count, bytes }) => ({
		provider,
		count,
		gzipBytes: bytes.length,
	}));
}

if (import.meta.main) console.log(await refreshSearchCatalogs());
