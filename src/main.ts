import { App, Plugin, PluginSettingTab, Setting, debounce } from "obsidian";
import { ScaleMode, SizeOptions, computeSizes } from "./sizes";

interface Settings extends SizeOptions {
    enabled: boolean;
}

const DEFAULT_SETTINGS: Settings = {
    enabled: true,
    depth: 3,
    decay: 0.5,
    countDuplicates: false,
    includeAttachments: false,
    scale: "log",
    minSize: 6,
    maxSize: 40,
};

/**
 * The graph renderer is undocumented Obsidian internals. We only rely on:
 *  renderer.nodes[]             nodes with `id` (file path), `renderer`, and a `getSize()` method
 *  renderer.setData/initGraphics  called whenever nodes are (re)built
 *  renderer.changed()           request a redraw
 *  renderer.fNodeSizeMult       the built-in "Node size" slider value
 * Everything is accessed defensively so a future change degrades to "stock graph", not an error.
 */
interface PatchedNode {
    orig: (...args: unknown[]) => number;
    hadOwn: boolean;
}

interface RendererState {
    active: boolean;
    restore: () => void;
}

// Typed interface for Graph Renderer internals
interface GraphRenderer {
    nodes?: Array<{
        id: string;
        renderer?: { fNodeSizeMult?: number };
        getSize?: (...args: unknown[]) => number;
        [key: string]: unknown;
    }>;
    changed?: () => void;
    setData?: (...args: unknown[]) => unknown;
    initGraphics?: (...args: unknown[]) => unknown;
    [key: string]: unknown;
}

const NODE_MARK = "__outlinkNodeSize";

export default class OutlinkNodeSizePlugin extends Plugin {
    settings: Settings = { ...DEFAULT_SETTINGS };

    /** node id (file path) -> display size, in Obsidian's own units (stock range is 8..30) */
    private sizes = new Map<string, number>();
    private renderers = new Map<GraphRenderer, RendererState>();

    scheduleRecompute = debounce(() => this.recompute(), 400, true);

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new OutlinkSettingTab(this.app, this));

        this.addCommand({
            id: "toggle-sizing",
            name: "Toggle outlink-based node sizing",
            callback: async () => {
                this.settings.enabled = !this.settings.enabled;
                await this.saveSettings();
                this.redrawAll();
            },
        });

        this.app.workspace.onLayoutReady(() => {
            this.recompute();

            this.registerEvent(this.app.metadataCache.on("resolved", () => this.scheduleRecompute()));
            this.registerEvent(this.app.vault.on("delete", () => this.scheduleRecompute()));
            this.registerEvent(this.app.vault.on("rename", () => this.scheduleRecompute()));
            this.registerEvent(this.app.workspace.on("layout-change", () => this.sweep()));
            this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.sweep()));

            // Safety net: catches graph views that load lazily or rebuild their nodes.
            this.registerInterval(window.setInterval(() => this.sweep(), 1000));
            this.sweep();
        });
    }

    onunload() {
        this.scheduleRecompute.cancel();
        for (const [renderer, state] of this.renderers) this.detach(renderer, state);
        this.renderers.clear();
    }

    // ---------------------------------------------------------------- settings

    async loadSettings() {
        const loaded = (await this.loadData()) as Partial<Settings>;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // ------------------------------------------------------------- computation

    recompute() {
        const resolved = this.app.metadataCache.resolvedLinks;
        this.sizes = computeSizes(resolved, this.settings as SizeOptions);
        this.redrawAll();
    }

    /** Size for a graph node id. Anything with no known outgoing links (tags, ghosts, ...) is a leaf => smallest. */
    private sizeFor(id: string): number {
        return this.sizes.get(id) ?? Math.min(this.settings.minSize, this.settings.maxSize);
    }

    redrawAll() {
        for (const renderer of this.renderers.keys()) renderer.changed?.();
    }

    // ----------------------------------------------------------- graph hooking

    private sweep() {
        const leaves = [
            ...this.app.workspace.getLeavesOfType("graph"),
            ...this.app.workspace.getLeavesOfType("localgraph"),
        ];
        const live = new Set<GraphRenderer>();

        for (const leaf of leaves) {
            const view = leaf.view as { renderer?: GraphRenderer };
            const renderer = view?.renderer;
            if (!renderer) continue; // deferred view, not loaded yet
            live.add(renderer);

            let state = this.renderers.get(renderer);
            if (!state) {
                state = this.attach(renderer);
                this.renderers.set(renderer, state);
            }
            if (this.patchNodes(renderer)) renderer.changed?.();
        }

        for (const [renderer, state] of this.renderers) {
            if (!live.has(renderer)) {
                this.detach(renderer, state);
                this.renderers.delete(renderer);
            }
        }
    }

    /** Wrap setData/initGraphics so freshly built nodes are patched before the next frame. */
    private attach(renderer: GraphRenderer): RendererState {
        const state: RendererState = { active: true, restore: () => {} };
        const wrapped: Array<{ key: "setData" | "initGraphics"; orig: (...args: unknown[]) => unknown; wrapper: (...args: unknown[]) => unknown }> = [];

        for (const key of ["setData", "initGraphics"] as const) {
            const orig = renderer[key];
            if (typeof orig !== "function") continue;
            const wrapper = (...args: unknown[]) => {
                const result = orig.apply(renderer, args);
                if (state.active) this.patchNodes(renderer);
                return result;
            };
            renderer[key] = wrapper;
            wrapped.push({ key, orig, wrapper });
        }

        state.restore = () => {
            // Only undo our wrapper if nobody wrapped on top of it; otherwise it just goes inert.
            for (const { key, orig, wrapper } of wrapped) {
                if (renderer[key] === wrapper) renderer[key] = orig;
            }
        };
        return state;
    }

    private detach(renderer: GraphRenderer, state: RendererState) {
        state.active = false;
        state.restore();
        this.unpatchNodes(renderer);
        renderer.changed?.();
    }

    /** Override getSize() on every node we haven't touched yet. Returns true if anything was patched. */
    private patchNodes(renderer: GraphRenderer): boolean {
        const nodes = renderer.nodes;
        if (!Array.isArray(nodes)) return false;

        let patchedAny = false;
        for (const node of nodes) {
            if (!node || node[NODE_MARK] || typeof node.getSize !== "function") continue;

            const info: PatchedNode = {
                orig: node.getSize,
                hadOwn: Object.prototype.hasOwnProperty.call(node, "getSize"),
            };
            node[NODE_MARK] = info;
            node.getSize = (...args: unknown[]): number => {
                if (!this.settings.enabled) return info.orig.apply(node, args);
                const mult = node.renderer?.fNodeSizeMult ?? 1;
                return mult * this.sizeFor(node.id);
            };
            patchedAny = true;
        }
        return patchedAny;
    }

    private unpatchNodes(renderer: GraphRenderer) {
        const nodes = renderer.nodes;
        if (!Array.isArray(nodes)) return;
        for (const node of nodes) {
            const info = node?.[NODE_MARK] as PatchedNode | undefined;
            if (!info) continue;
            if (info.hadOwn) node.getSize = info.orig;
            else delete node.getSize;
            delete node[NODE_MARK];
        }
    }
}

// ------------------------------------------------------------------ settings UI

class OutlinkSettingTab extends PluginSettingTab {
    constructor(app: App, private plugin: OutlinkNodeSizePlugin) {
        super(app, plugin);
    }

    getSettingDefinitions() {
        return [];
    }

    display(): void {
        const { containerEl } = this;
        const s = this.plugin.settings;
        containerEl.empty();

        const change = async () => {
            await this.plugin.saveSettings();
            this.plugin.scheduleRecompute();
        };

        new Setting(containerEl)
            .setName("Enable outlink sizing")
            .setDesc("Turn off to get the stock graph node sizes back.")
            .addToggle((t) =>
                t.setValue(s.enabled).onChange(async (v) => {
                    s.enabled = v;
                    await this.plugin.saveSettings();
                    this.plugin.redrawAll();
                })
            );

        new Setting(containerEl).setName("How size is computed").setHeading();

        new Setting(containerEl)
            .setName("Propagation depth")
            .setDesc(
                "How many link-hops are followed. 1 = only direct links count; higher values let a note inherit size from the notes its linked notes link to."
            )
            .addSlider((sl) =>
                sl.setLimits(1, 8, 1).setValue(s.depth).onChange(async (v) => {
                    s.depth = v;
                    await change();
                })
            );

        new Setting(containerEl)
            .setName("Decay")
            .setDesc(
                "How much of a linked note's size is passed up to the note that links to it. size = 1 + decay × (sum of linked notes' sizes)."
            )
            .addSlider((sl) =>
                sl.setLimits(0.05, 1, 0.05).setValue(s.decay).onChange(async (v) => {
                    s.decay = v;
                    await change();
                })
            );

        new Setting(containerEl)
            .setName("Count repeated links")
            .setDesc("If a note links to the same target several times, count every link instead of once.")
            .addToggle((t) =>
                t.setValue(s.countDuplicates).onChange(async (v) => {
                    s.countDuplicates = v;
                    await change();
                })
            );

        new Setting(containerEl)
            .setName("Include attachments")
            .setDesc("Let links and embeds of images, PDFs and other non-note files add to a note's size.")
            .addToggle((t) =>
                t.setValue(s.includeAttachments).onChange(async (v) => {
                    s.includeAttachments = v;
                    await change();
                })
            );

        new Setting(containerEl).setName("How size is displayed").setHeading();

        new Setting(containerEl)
            .setName("Scale")
            .setDesc(
                "Logarithmic keeps a few huge hubs from flattening everything else. Percentile rank spreads nodes evenly regardless of the numbers."
            )
            .addDropdown((d) =>
                d
                    .addOptions({
                        log: "Logarithmic",
                        sqrt: "Square root",
                        linear: "Linear",
                        rank: "Percentile rank",
                    } satisfies Record<ScaleMode, string>)
                    .setValue(s.scale)
                    .onChange(async (v) => {
                        s.scale = v as ScaleMode;
                        await change();
                    })
            );

        new Setting(containerEl)
            .setName("Smallest node")
            .setDesc("Size of a note that links to nothing. Obsidian's default range is roughly 8 to 30.")
            .addSlider((sl) =>
                sl.setLimits(2, 40, 1).setValue(s.minSize).onChange(async (v) => {
                    s.minSize = v;
                    await change();
                })
            );

        new Setting(containerEl)
            .setName("Largest node")
            .setDesc("Size of the note with the greatest aggregate outlink size. The graph's own Node size slider still scales everything.")
            .addSlider((sl) =>
                sl.setLimits(10, 120, 1).setValue(s.maxSize).onChange(async (v) => {
                    s.maxSize = v;
                    await change();
                })
            );
    }
}
