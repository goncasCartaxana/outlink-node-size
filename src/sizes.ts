/**
 * Pure size computation (no Obsidian imports, so it can be unit-tested in Node).
 *
 * Idea: the inverse of PageRank. A note's raw "mass" is
 *
 *     mass(n) = 1 + decay * sum( mass(t) for every note t that n links to )
 *
 * evaluated by iterating `depth` times (so cycles can never diverge). A note
 * that links to nothing has mass 1; a note that links to big notes becomes big.
 * Masses are then mapped onto a display size range.
 */

export type ScaleMode = "log" | "sqrt" | "linear" | "rank";

export interface SizeOptions {
	depth: number;
	decay: number;
	countDuplicates: boolean;
	includeAttachments: boolean;
	scale: ScaleMode;
	minSize: number;
	maxSize: number;
}

/** Shape of app.metadataCache.resolvedLinks: source path -> (target path -> link count). */
export type ResolvedLinks = Record<string, Record<string, number>>;

export function computeMass(resolved: ResolvedLinks, o: SizeOptions): Map<string, number> {
	const index = new Map<string, number>();
	const names: string[] = [];
	const idOf = (p: string): number => {
		let i = index.get(p);
		if (i === undefined) {
			i = names.length;
			index.set(p, i);
			names.push(p);
		}
		return i;
	};

	const targets: number[][] = [];
	const weights: number[][] = [];

	for (const src of Object.keys(resolved)) {
		const si = idOf(src);
		const t: number[] = [];
		const w: number[] = [];
		const row = resolved[src];
		for (const dst of Object.keys(row)) {
			if (dst === src) continue;
			if (!o.includeAttachments && !dst.endsWith(".md")) continue;
			t.push(idOf(dst));
			w.push(o.countDuplicates ? row[dst] : 1);
		}
		targets[si] = t;
		weights[si] = w;
	}

	const n = names.length;
	let prev = new Float64Array(n).fill(1);
	for (let k = 0; k < Math.max(1, o.depth); k++) {
		const next = new Float64Array(n);
		for (let i = 0; i < n; i++) {
			const t = targets[i];
			let sum = 0;
			if (t) {
				const w = weights[i];
				for (let j = 0; j < t.length; j++) sum += w[j] * prev[t[j]];
			}
			next[i] = 1 + o.decay * sum;
		}
		prev = next;
	}

	const out = new Map<string, number>();
	for (let i = 0; i < n; i++) out.set(names[i], prev[i]);
	return out;
}

/** Map raw masses onto [minSize, maxSize] (in Obsidian's own node-size units; stock range is 8..30). */
export function computeSizes(resolved: ResolvedLinks, o: SizeOptions): Map<string, number> {
	const mass = computeMass(resolved, o);
	const lo = Math.min(o.minSize, o.maxSize);
	const hi = Math.max(o.minSize, o.maxSize);
	const sizes = new Map<string, number>();
	if (mass.size === 0) return sizes;

	let maxMass = 1;
	for (const v of mass.values()) if (v > maxMass) maxMass = v;

	let toT: (m: number) => number;
	if (o.scale === "rank") {
		const sorted = Float64Array.from(mass.values()).sort();
		const firstIndex = new Map<number, number>();
		for (let i = 0; i < sorted.length; i++) {
			if (i === 0 || sorted[i] !== sorted[i - 1]) firstIndex.set(sorted[i], i);
		}
		const denom = Math.max(1, sorted.length - 1);
		toT = (m) => (firstIndex.get(m) ?? 0) / denom;
	} else {
		const f =
			o.scale === "linear" ? (m: number) => m - 1 :
			o.scale === "sqrt" ? (m: number) => Math.sqrt(m - 1) :
			(m: number) => Math.log(m);
		const top = f(maxMass);
		toT = (m) => (top > 0 ? f(m) / top : 0);
	}

	for (const [id, m] of mass) sizes.set(id, lo + toT(m) * (hi - lo));
	return sizes;
}
